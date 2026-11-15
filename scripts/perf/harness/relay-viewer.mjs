import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { decodeFrame, encodeControlMessage, encodeFrame } from "@limccn/tokimeki-protocol";
import { WebSocket } from "ws";

import { nowNs, nsToMs } from "./metrics.mjs";

const CONTROL_TIMEOUT_MS = Number(process.env.TOKIMEKI_PERF_CONTROL_TIMEOUT_MS ?? 10_000);
const OPEN_TIMEOUT_MS = Number(process.env.TOKIMEKI_PERF_OPEN_TIMEOUT_MS ?? 10_000);
const NONCE_PREFIX = "PERF_NONCE:";
const NONCE_LENGTH = 36;

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
 * Synthetic relay viewer used by the perf harness.
 *
 * It ACKs every OUTPUT/SNAPSHOT_TO by default, can stop reading/ACKing to
 * exercise relay flow control, and measures input->echo latency with nonces.
 */
export class RelayViewer extends EventEmitter {
  #relayUrl;
  #session;
  #sessionToken;
  #clientId;
  #cols;
  #rows;
  #ackMode;
  #ws = null;
  #controls = [];
  #waiters = [];
  #receivedPayloadBytes = 0;
  #receivedWireBytes = 0;
  #receivedFrames = 0;
  #firstRecvAt = null;
  #lastRecvAt = null;
  #latencySamplesMs = [];
  #pendingInputs = new Map();
  #lastReceivedSeq = -1;
  #markerWaiters = [];
  #snapshots = [];
  #snapshotWaiters = [];
  #byteWaiters = [];
  #nextByteTarget = Number.POSITIVE_INFINITY;
  #latencyWaiters = [];
  #pauses = [];
  #resumes = [];
  #errors = [];
  #closeInfo = null;
  #closeWaiters = [];
  #stalled = false;

  constructor({
    relayUrl,
    session,
    sessionToken,
    clientId,
    cols = 80,
    rows = 24,
    ackMode = "ack-all",
  }) {
    super();
    this.#relayUrl = relayUrl;
    this.#session = session;
    this.#sessionToken = sessionToken;
    this.#clientId = clientId;
    this.#cols = cols;
    this.#rows = rows;
    this.#ackMode = ackMode;
  }

  get clientId() {
    return this.#clientId;
  }

  get errors() {
    return [...this.#errors];
  }

  get closeInfo() {
    return this.#closeInfo;
  }

  get receivedPayloadBytes() {
    return this.#receivedPayloadBytes;
  }

  get receivedWireBytes() {
    return this.#receivedWireBytes;
  }

  get receivedFrames() {
    return this.#receivedFrames;
  }

  get latencySamplesMs() {
    return [...this.#latencySamplesMs];
  }

  get snapshots() {
    return [...this.#snapshots];
  }

  get pauses() {
    return [...this.#pauses];
  }

  get resumes() {
    return [...this.#resumes];
  }

  async connect() {
    const url = `${this.#relayUrl.replace(/\/$/, "")}/ws/${encodeURIComponent(this.#session)}`;
    const ws = new WebSocket(url, {
      headers: { "x-tokimeki-session": this.#sessionToken },
      perMessageDeflate: false,
    });
    this.#ws = ws;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("relay viewer: open timeout")),
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

    ws.on("message", (data, isBinary) => this.#onMessage(data, isBinary));
    ws.on("error", (error) => {
      this.#errors.push(`socket: ${error instanceof Error ? error.message : String(error)}`);
    });
    ws.on("close", (code, reason) => {
      this.#closeInfo = { code, reason: reason.toString() };
      for (const waiter of this.#closeWaiters.splice(0)) {
        waiter(this.#closeInfo);
      }
    });

    ws.send(
      encodeControlMessage({
        v: 1,
        type: "hello",
        role: "viewer",
        session: this.#session,
        clientId: this.#clientId,
        protocolVersion: 1,
        capabilities: {},
        cols: this.#cols,
        rows: this.#rows,
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
      if (message.type === "pause") {
        this.#pauses.push({ at: nowNs(), clientId: message.clientId ?? null });
      } else if (message.type === "resume") {
        this.#resumes.push({ at: nowNs(), clientId: message.clientId ?? null });
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
    if (frame.type !== "output" && frame.type !== "snapshot_to") {
      return;
    }

    const at = nowNs();
    this.#receivedPayloadBytes += frame.payload.byteLength;
    this.#receivedWireBytes += bytes.byteLength;
    this.#receivedFrames += 1;
    this.#lastReceivedSeq = Math.max(this.#lastReceivedSeq, frame.seq);
    if (this.#firstRecvAt === null) {
      this.#firstRecvAt = at;
    }
    this.#lastRecvAt = at;

    if (this.#ackMode === "ack-all") {
      this.#sendAck(frame.seq);
    }

    const payload = frame.payload;
    if (this.#markerWaiters.length > 0 && payload.byteLength <= 256) {
      const text = new TextDecoder().decode(payload);
      for (const waiter of [...this.#markerWaiters]) {
        if (text.includes(waiter.marker)) {
          clearTimeout(waiter.timer);
          this.#markerWaiters.splice(this.#markerWaiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    }
    const head = new TextDecoder().decode(
      payload.subarray(0, Math.min(payload.byteLength, NONCE_PREFIX.length + NONCE_LENGTH)),
    );
    if (head.startsWith(NONCE_PREFIX)) {
      const nonce = head.slice(NONCE_PREFIX.length, NONCE_PREFIX.length + NONCE_LENGTH);
      const sentAt = this.#pendingInputs.get(nonce);
      if (sentAt !== undefined) {
        this.#pendingInputs.delete(nonce);
        this.#latencySamplesMs.push(nsToMs(at - sentAt));
        for (const waiter of this.#latencyWaiters.splice(0)) {
          waiter();
        }
      }
    }

    if (frame.type === "snapshot_to") {
      this.#snapshots.push({
        targetId: frame.targetId,
        seq: frame.seq,
        bytes: frame.payload.byteLength,
        at,
      });
      for (const waiter of this.#snapshotWaiters.splice(0)) {
        waiter();
      }
    }

    if (this.#receivedPayloadBytes >= this.#nextByteTarget) {
      for (const waiter of this.#byteWaiters.splice(0)) {
        waiter();
      }
    }
    this.emit("frame", frame);
  }

  #sendAck(seq) {
    if (this.#ws === null || this.#ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.#ws.send(encodeControlMessage({ v: 1, type: "ack", seq: String(seq) }));
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
        reject(new Error(`relay viewer: timeout waiting for ${type}`));
      }, timeoutMs);
      this.#waiters.push({ type, predicate, resolve, reject, timer });
    });
  }

  async waitForBytes(bytes, timeoutMs = 30_000) {
    if (this.#receivedPayloadBytes >= bytes) {
      return this.#receivedPayloadBytes;
    }
    this.#nextByteTarget = bytes;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`relay viewer: timeout waiting for ${bytes} bytes`)),
        timeoutMs,
      );
      this.#byteWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this.#receivedPayloadBytes;
  }

  async waitForLatencySamples(count, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (this.#latencySamplesMs.length < count) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`relay viewer: timeout waiting for ${count} latency samples`);
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.#latencyWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.#latencySamplesMs.length;
  }

  async waitForSnapshot(timeoutMs = 10_000) {
    if (this.#snapshots.length > 0) {
      return this.#snapshots[0];
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("relay viewer: timeout waiting for snapshot")),
        timeoutMs,
      );
      this.#snapshotWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this.#snapshots[0];
  }

  /** Wait for a small OUTPUT payload containing `marker` (flow-control end). */
  async waitForMarker(marker, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#markerWaiters.findIndex((waiter) => waiter.marker === marker);
        if (index >= 0) {
          this.#markerWaiters.splice(index, 1);
        }
        reject(new Error(`relay viewer: timeout waiting for marker ${marker}`));
      }, timeoutMs);
      this.#markerWaiters.push({ marker, resolve, reject, timer });
    });
  }

  /** Send an INPUT probe with a nonce; the host echoes it as OUTPUT. */
  sendInput({ paddingBytes = 0, nonce = randomUUID() } = {}) {
    if (this.#ws === null || this.#ws.readyState !== WebSocket.OPEN) {
      throw new Error("relay viewer: not connected");
    }
    const payload = Buffer.concat([
      Buffer.from(`${NONCE_PREFIX}${nonce}`, "utf8"),
      Buffer.alloc(paddingBytes, 0x20),
    ]);
    this.#pendingInputs.set(nonce, nowNs());
    this.#ws.send(encodeFrame({ type: "input", payload }));
    return nonce;
  }

  /** Ask the host for a fresh snapshot (targeted resync). */
  sendResync(fromSeq = "0") {
    if (this.#ws === null || this.#ws.readyState !== WebSocket.OPEN) {
      throw new Error("relay viewer: not connected");
    }
    this.#ws.send(encodeControlMessage({ v: 1, type: "resync", fromSeq }));
  }

  /** Snapshot of cumulative counters (used by matrix repetitions). */
  stats() {
    return {
      receivedPayloadBytes: this.#receivedPayloadBytes,
      receivedWireBytes: this.#receivedWireBytes,
      receivedFrames: this.#receivedFrames,
      firstRecvAt: this.#firstRecvAt,
      lastRecvAt: this.#lastRecvAt,
      latencySamplesMs: [...this.#latencySamplesMs],
      snapshots: [...this.#snapshots],
      pauses: [...this.#pauses],
      resumes: [...this.#resumes],
    };
  }

  /** Clear counters between repetitions; call only while idle. */
  resetStats() {
    this.#receivedPayloadBytes = 0;
    this.#receivedWireBytes = 0;
    this.#receivedFrames = 0;
    this.#firstRecvAt = null;
    this.#lastRecvAt = null;
    this.#latencySamplesMs = [];
    this.#pendingInputs.clear();
    this.#lastReceivedSeq = -1;
    this.#snapshots = [];
    this.#pauses = [];
    this.#resumes = [];
    this.#nextByteTarget = Number.POSITIVE_INFINITY;
  }

  /**
   * Stop ACKing while still reading. The relay's unacked-byte flow control
   * depends on application ACKs; pausing the socket would make the relay's
   * send fail early and bypass the pause/hard-limit path.
   */
  stall() {
    this.#ackMode = "none";
    this.#stalled = true;
  }

  /** Resume ACKing and acknowledge everything received while stalled. */
  resume() {
    this.#stalled = false;
    this.#ackMode = "ack-all";
    if (this.#lastReceivedSeq >= 0) {
      this.#sendAck(this.#lastReceivedSeq);
    }
  }

  /** Stop ACKing forever; used for the hard-limit test. */
  neverRead() {
    this.#ackMode = "none";
    this.#stalled = true;
  }

  waitForClose(timeoutMs = 10_000) {
    if (this.#closeInfo !== null) {
      return Promise.resolve(this.#closeInfo);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("relay viewer: timeout waiting for close")),
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
