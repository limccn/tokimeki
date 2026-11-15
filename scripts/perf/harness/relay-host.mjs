import { EventEmitter } from "node:events";

import { decodeFrame, encodeControlMessage, encodeFrame } from "@limccn/tokimeki-protocol";
import { WebSocket } from "ws";

import { nowNs, sleep } from "./metrics.mjs";

const CONTROL_TIMEOUT_MS = Number(process.env.TOKIMEKI_PERF_CONTROL_TIMEOUT_MS ?? 10_000);
const OPEN_TIMEOUT_MS = Number(process.env.TOKIMEKI_PERF_OPEN_TIMEOUT_MS ?? 10_000);
const BUFFER_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;

function asBytes(data) {
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

/**
 * Synthetic relay host used by the perf harness.
 *
 * It speaks the same header/hello handshake as the real CLI, sends OUTPUT
 * frames, echoes viewer INPUT for latency probes, answers resync with
 * SNAPSHOT_TO, and honors relay pause/resume backpressure.
 */
export class RelayHost extends EventEmitter {
  #relayUrl;
  #session;
  #masterToken;
  #sessionToken;
  #clientId;
  #ws = null;
  #seq = 0;
  #paused = new Set();
  #pauseWaiters = [];
  #controls = [];
  #waiters = [];
  #viewerIds = new Set();
  #viewerWaiters = [];
  #pauseEvents = [];
  #resumeEvents = [];
  #autoEcho;
  #resyncPayloadBytes;
  #errors = [];
  #closed = false;
  #closeInfo = null;
  #closeWaiters = [];

  constructor({
    relayUrl,
    session,
    masterToken,
    sessionToken,
    clientId = "perf-host",
    autoEcho = true,
    resyncPayloadBytes = 64,
  }) {
    super();
    this.#relayUrl = relayUrl;
    this.#session = session;
    this.#masterToken = masterToken;
    this.#sessionToken = sessionToken;
    this.#clientId = clientId;
    this.#autoEcho = autoEcho;
    this.#resyncPayloadBytes = resyncPayloadBytes;
  }

  get clientId() {
    return this.#clientId;
  }

  get errors() {
    return [...this.#errors];
  }

  get pausedViewers() {
    return new Set(this.#paused);
  }

  get viewerIds() {
    return new Set(this.#viewerIds);
  }

  get controls() {
    return [...this.#controls];
  }

  get pauseEvents() {
    return [...this.#pauseEvents];
  }

  get resumeEvents() {
    return [...this.#resumeEvents];
  }

  get closeInfo() {
    return this.#closeInfo;
  }

  async connect() {
    const url = `${this.#relayUrl.replace(/\/$/, "")}/ws/${encodeURIComponent(this.#session)}`;
    const ws = new WebSocket(url, {
      headers: {
        "x-tokimeki-master": this.#masterToken,
        "x-tokimeki-session": this.#sessionToken,
      },
      perMessageDeflate: false,
    });
    this.#ws = ws;

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("relay host: open timeout")),
          OPEN_TIMEOUT_MS,
        );
        ws.once("open", () => {
          clearTimeout(timer);
          resolve();
        });
        ws.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    } catch (error) {
      try {
        ws.terminate();
      } catch {
        // best effort
      }
      this.#ws = null;
      throw error;
    }

    ws.on("message", (data, isBinary) => this.#onMessage(data, isBinary));
    ws.on("error", (error) => {
      this.#errors.push(`socket: ${error instanceof Error ? error.message : String(error)}`);
    });
    ws.on("close", (code, reason) => {
      this.#closed = true;
      this.#closeInfo = { code, reason: reason.toString() };
      for (const waiter of this.#closeWaiters.splice(0)) {
        waiter(this.#closeInfo);
      }
    });

    ws.send(
      encodeControlMessage({
        v: 1,
        type: "hello",
        role: "host",
        session: this.#session,
        clientId: this.#clientId,
        protocolVersion: 1,
        capabilities: {},
      }),
    );
    await this.waitForControl("welcome");
    return this;
  }

  #onMessage(data, isBinary) {
    if (!isBinary) {
      let message;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        this.#errors.push("control: invalid JSON");
        return;
      }
      this.#controls.push(message);
      if (message.type === "pause" && typeof message.clientId === "string") {
        this.#paused.add(message.clientId);
        this.#pauseEvents.push({ at: nowNs(), clientId: message.clientId });
      } else if (message.type === "resume" && typeof message.clientId === "string") {
        this.#paused.delete(message.clientId);
        this.#resumeEvents.push({ at: nowNs(), clientId: message.clientId });
        if (this.#paused.size === 0) {
          for (const resolve of this.#pauseWaiters.splice(0)) {
            resolve();
          }
        }
      } else if (message.type === "peer-joined" && typeof message.clientId === "string") {
        this.#viewerIds.add(message.clientId);
        for (const waiter of this.#viewerWaiters.splice(0)) {
          waiter();
        }
      } else if (message.type === "peer-left" && typeof message.clientId === "string") {
        this.#viewerIds.delete(message.clientId);
      } else if (message.type === "resync") {
        const targetId = typeof message.clientId === "string" ? message.clientId : null;
        if (targetId !== null) {
          this.sendSnapshot({
            targetId,
            payload: Buffer.alloc(this.#resyncPayloadBytes, 0x41),
          });
        }
      }
      for (const waiter of [...this.#waiters]) {
        if (waiter.type !== message.type) {
          continue;
        }
        if (waiter.predicate !== null && !waiter.predicate(message)) {
          continue;
        }
        clearTimeout(waiter.timer);
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
      this.emit("control", message);
      return;
    }

    const bytes = asBytes(data);
    if (bytes === null) {
      return;
    }
    let frame;
    try {
      frame = decodeFrame(bytes);
    } catch (error) {
      this.#errors.push(`binary: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (frame.type === "input") {
      this.emit("input", frame.payload);
      if (this.#autoEcho) {
        this.#sendOutputPayload(frame.payload);
      }
    }
  }

  waitForControl(type, predicate = null, timeoutMs = CONTROL_TIMEOUT_MS) {
    const existing = this.#controls.find(
      (message) => message.type === type && (predicate === null || predicate(message)),
    );
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) {
          this.#waiters.splice(index, 1);
        }
        reject(new Error(`relay host: timeout waiting for ${type}`));
      }, timeoutMs);
      this.#waiters.push({ type, predicate, resolve, reject, timer });
    });
  }

  async waitForViewerCount(count, timeoutMs = CONTROL_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (this.#viewerIds.size < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`relay host: timeout waiting for ${count} viewers`);
      }
      await new Promise((resolve, reject) => {
        let waiter = null;
        const timer = setTimeout(() => {
          if (waiter !== null) {
            const index = this.#viewerWaiters.indexOf(waiter);
            if (index >= 0) {
              this.#viewerWaiters.splice(index, 1);
            }
          }
          reject(new Error(`relay host: timeout waiting for ${count} viewers`));
        }, remaining);
        waiter = () => {
          clearTimeout(timer);
          resolve();
        };
        this.#viewerWaiters.push(waiter);
      });
    }
    return this.#viewerIds.size;
  }

  async #waitForResume() {
    while (this.#paused.size > 0) {
      await new Promise((resolve) => this.#pauseWaiters.push(resolve));
    }
  }

  async #waitForBufferDrain() {
    while (this.#ws !== null && this.#ws.bufferedAmount > BUFFER_HIGH_WATER_BYTES) {
      await sleep(2);
    }
  }

  #sendOutputPayload(payload) {
    if (this.#ws === null || this.#ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const frame = encodeFrame({ type: "output", seq: this.#seq, payload });
    this.#seq += 1;
    this.#ws.send(frame);
  }

  /**
   * Send `totalBytes` of OUTPUT payload as fast as the relay accepts it.
   * Pause/resume control messages and the socket buffer bound host memory.
   */
  async sendOutput({
    frameBytes = 1024,
    totalBytes = 1024 * 1024,
    paceBytes = 0,
    paceDelayMs = 0,
    ignorePause = false,
  } = {}) {
    if (this.#ws === null || this.#ws.readyState !== WebSocket.OPEN) {
      throw new Error("relay host: not connected");
    }
    if (frameBytes <= 0 || frameBytes > MAX_FRAME_BYTES) {
      throw new Error(`relay host: frameBytes must be 1..${MAX_FRAME_BYTES}`);
    }
    const payload = Buffer.alloc(Math.min(frameBytes, MAX_FRAME_BYTES), 0x61);
    const startedAt = nowNs();
    let sentBytes = 0;
    let frames = 0;
    let nextPaceAt = paceBytes;
    while (sentBytes < totalBytes) {
      if (!ignorePause && this.#paused.size > 0) {
        await this.#waitForResume();
      }
      if (this.#ws.bufferedAmount > BUFFER_HIGH_WATER_BYTES) {
        await this.#waitForBufferDrain();
      }
      const size = Math.min(payload.byteLength, totalBytes - sentBytes);
      const frame = encodeFrame({
        type: "output",
        seq: this.#seq,
        payload: payload.subarray(0, size),
      });
      this.#seq += 1;
      this.#ws.send(frame);
      sentBytes += size;
      frames += 1;
      if (paceBytes > 0 && paceDelayMs > 0 && sentBytes >= nextPaceAt) {
        // Yield to the relay/DO so per-viewer ACKs drain below the flow-control
        // high-water mark; otherwise a full-speed 1 KiB burst drops frames.
        await sleep(paceDelayMs);
        nextPaceAt += paceBytes;
      }
    }
    return {
      sentBytes,
      frames,
      startedAt,
      finishedAt: nowNs(),
      pauses: this.#controls.filter((message) => message.type === "pause").length,
      resumes: this.#controls.filter((message) => message.type === "resume").length,
    };
  }

  sendSnapshot({ targetId, payload }) {
    if (this.#ws === null || this.#ws.readyState !== WebSocket.OPEN) {
      throw new Error("relay host: not connected");
    }
    const frame = encodeFrame({
      type: "snapshot_to",
      targetId,
      seq: this.#seq,
      payload,
    });
    this.#seq += 1;
    this.#ws.send(frame);
  }

  /** Send a small terminal marker as OUTPUT (flow-control assertions). */
  sendMarker(text = "PERF_END") {
    this.#sendOutputPayload(Buffer.from(text, "utf8"));
  }

  /** Announce host exit so viewers receive the normal lifecycle event. */
  sendHostExited({ exitCode = 0, signal = null } = {}) {
    if (this.#ws === null || this.#ws.readyState !== WebSocket.OPEN) {
      throw new Error("relay host: not connected");
    }
    this.#ws.send(
      encodeControlMessage({
        v: 1,
        type: "host-exited",
        ...(exitCode === null ? {} : { exitCode }),
        ...(signal === null ? {} : { signal }),
      }),
    );
  }

  waitForClose(timeoutMs = 10_000) {
    if (this.#closeInfo !== null) {
      return Promise.resolve(this.#closeInfo);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("relay host: timeout waiting for close")),
        timeoutMs,
      );
      this.#closeWaiters.push((info) => {
        clearTimeout(timer);
        resolve(info);
      });
    });
  }

  async close() {
    if (this.#ws === null) {
      return;
    }
    if (this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.close(1000, "perf done");
    }
    try {
      await this.waitForClose(2_000);
    } catch {
      // best effort
    }
  }
}
