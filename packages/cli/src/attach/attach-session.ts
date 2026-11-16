/**
 * Attach (viewer) session.
 *
 * stdout only ever contains remote terminal bytes and the local mode
 * sequences needed to present them (alternate screen, clear, restore). All
 * diagnostics go to stderr and are muted while the remote screen is active so
 * log lines cannot corrupt escape sequences.
 */

import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";

import {
  decodeFrame,
  encodeFrame,
  type IceTransportPolicy,
  type KnownControlMessage,
  PROTOCOL_VERSION,
  type TransportMode,
  toU64String,
  type WelcomeMessage,
} from "@limccn/tokimeki-protocol";

import type { AttachConfig } from "../config.js";
import { formatError, type Logger } from "../logger.js";
import {
  CLEAR_SCREEN,
  ENTER_ALTERNATE_SCREEN,
  terminalRestoreSequence,
} from "../terminal/restore.js";
import { buildCapabilities } from "../transport/capabilities.js";
import { buildNodeRtcConfig, resolveIceTransportPolicy } from "../transport/ice.js";
import { IceConfigManager } from "../transport/ice-config.js";
import { P2PPeer } from "../transport/p2p-peer.js";
import { RelayClient } from "../transport/relay-client.js";
import { RelayTransport } from "../transport/relay-transport.js";
import type { RelayConnectionState, RelayFatalError } from "../transport/relay-types.js";
import { RouteSelector } from "../transport/route-selector.js";
import type { Transport } from "../transport/types.js";
import { isStaleSnapshot, SeqReducer } from "./seq-reducer.js";

export interface AttachSessionDeps {
  readonly logger: Logger;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly platform?: NodeJS.Platform;
}

const RESYNC_THROTTLE_MS = 500;
/** Pre-switch DC output buffer bound; overflow forces a fresh snapshot. */
const DC_BUFFER_LIMIT_BYTES = 4_194_304;

interface BufferedOutput {
  readonly seq: number;
  readonly payload: Uint8Array;
}

type SizedWriteStream = NodeJS.WriteStream & { columns?: number; rows?: number; fd?: number };

export async function runAttachSession(
  config: AttachConfig,
  deps: AttachSessionDeps,
): Promise<number> {
  const session = new AttachSession(config, deps);
  return session.run();
}

class AttachSession {
  readonly #config: AttachConfig;
  readonly #logger: Logger;
  readonly #stdin: NodeJS.ReadStream;
  readonly #stdout: NodeJS.WriteStream;
  readonly #clientId = randomUUID();
  readonly #reducer = new SeqReducer();

  #client: RelayClient | null = null;
  #transport: Transport | null = null;
  readonly #iceManager: IceConfigManager;
  #iceTransportPolicy: IceTransportPolicy;
  #peer: P2PPeer | null = null;
  #p2pReady = false;
  #p2pSnapshotSeen = false;
  #p2pBufferOverflow = false;
  #dcBuffer: BufferedOutput[] = [];
  #dcBufferBytes = 0;
  #interactive = false;
  #rawMode = false;
  #screenActive = false;
  #stdoutPaused = false;
  #lastResyncAt = 0;
  #closing = false;
  #finished = false;
  #finalMessage: string | null = null;
  #resolveFinished: ((code: number) => void) | null = null;
  readonly #finishedPromise: Promise<number>;

  #stdinHandler: ((chunk: Buffer | string) => void) | null = null;
  #resizeHandler: (() => void) | null = null;
  #signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];
  #exitHandler: (() => void) | null = null;
  #hostExitTimer: NodeJS.Timeout | null = null;

  constructor(config: AttachConfig, deps: AttachSessionDeps) {
    this.#config = config;
    this.#iceTransportPolicy = config.iceTransportPolicy;
    this.#logger = deps.logger;
    this.#stdin = deps.stdin ?? process.stdin;
    this.#stdout = deps.stdout ?? process.stdout;
    this.#finishedPromise = new Promise<number>((resolve) => {
      this.#resolveFinished = resolve;
    });
    this.#iceManager = new IceConfigManager({
      logger: this.#logger,
      sendIceRefresh: (provider) => {
        this.#client?.sendControl({
          v: PROTOCOL_VERSION,
          type: "ice-refresh",
          ...(provider === undefined ? {} : { provider }),
        });
      },
    });
  }

  async run(): Promise<number> {
    this.#interactive = this.#stdin.isTTY === true && this.#stdout.isTTY === true;
    this.#installLocalTerminal();

    const client = new RelayClient({
      url: this.#config.websocketUrl,
      headers: {
        "X-Tokimeki-Session": this.#config.sessionToken,
      },
      role: "viewer",
      session: this.#config.session,
      clientId: this.#clientId,
      cols: this.#localSize().cols,
      rows: this.#localSize().rows,
      heartbeatSeconds: this.#config.heartbeatSeconds,
      capabilities: buildCapabilities({ p2p: this.#config.p2p === "auto" }),
      logger: this.#logger,
    });
    this.#client = client;
    client.onWelcome((welcome) => this.#handleWelcome(welcome));
    client.onMessage((message) => this.#handleControl(message));
    client.onState((state) => this.#handleState(state));
    client.onFatal((error) => this.#handleFatal(error));

    const selector = new RouteSelector({
      p2p: this.#config.p2p,
      logger: this.#logger,
      createRelayTransport: () => new RelayTransport(client),
    });
    void selector
      .select()
      .then((transport) => {
        this.#transport = transport;
        transport.onFrame((bytes) => this.#handleFrame(bytes));
        client.start();
      })
      .catch((error: unknown) => {
        this.#logger.error(`failed to select transport: ${formatError(error)}`);
        this.#finish(1);
      });

    const code = await this.#finishedPromise;
    this.#cleanup();
    return code;
  }

  #localSize(): { cols: number; rows: number } {
    const sized = this.#stdout as SizedWriteStream;
    return {
      cols: Math.max(1, typeof sized.columns === "number" ? sized.columns : 80),
      rows: Math.max(1, typeof sized.rows === "number" ? sized.rows : 24),
    };
  }

  #installLocalTerminal(): void {
    this.#stdinHandler = (chunk) => {
      if (!this.#screenActive) return;
      const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      if (data.byteLength === 0) return;
      try {
        const frame = encodeFrame({ type: "input", payload: data });
        // Control-plane frames stay on the relay; terminal input prefers the
        // direct path once the host has announced it ready.
        if (this.#p2pReady && this.#peer !== null && this.#peer.send(frame)) {
          return;
        }
        this.#transport?.send(frame);
      } catch (error) {
        this.#logger.debug(`failed to encode input: ${formatError(error)}`);
      }
    };
    try {
      this.#stdin.resume();
      this.#stdin.on("data", this.#stdinHandler);
    } catch {
      // stdin may not be readable
    }

    this.#resizeHandler = () => this.#sendResize();
    process.on("SIGWINCH", this.#resizeHandler);
    try {
      (this.#stdout as SizedWriteStream).on("resize", this.#resizeHandler);
    } catch {
      // non-TTY streams do not resize
    }

    const onSignal = (signal: NodeJS.Signals, code: number) => {
      const handler = () => this.#finish(code);
      this.#signalHandlers.push({ signal, handler });
      process.once(signal, handler);
    };
    onSignal("SIGINT", 130);
    onSignal("SIGTERM", 143);

    this.#exitHandler = () => {
      if (!this.#screenActive) return;
      const fd = (this.#stdout as SizedWriteStream).fd;
      if (typeof fd !== "number") return;
      try {
        writeSync(fd, terminalRestoreSequence());
      } catch {
        // best effort
      }
    };
    process.once("exit", this.#exitHandler);
  }

  #handleWelcome(welcome: WelcomeMessage): void {
    this.#iceManager.updateFromWelcome(welcome);
    this.#iceTransportPolicy = resolveIceTransportPolicy(
      this.#config.iceTransportPolicy,
      welcome.transportPolicy,
    );
    this.#logger.debug(
      `relay welcome: session=${welcome.session} hostOnline=${String(welcome.hostOnline)} ` +
        `iceProvider=${welcome.iceProvider}`,
    );
    if (!welcome.hostOnline) {
      this.#logger.warn("host is offline; waiting for it to come online");
    }
    this.#reducer.reset();
    this.#logger.info(`attached to session ${this.#config.session}`);
    this.#enterScreen();
    // Tell the host our terminal size even if the relay did not synthesize a
    // resize from hello. The host ignores no-op resizes.
    this.#sendResize();
  }

  #enterScreen(): void {
    this.#screenActive = true;
    if (!this.#interactive) return;
    this.#writeRaw(ENTER_ALTERNATE_SCREEN);
    this.#logger.setMuted(true);
    try {
      this.#stdin.setRawMode(true);
      this.#rawMode = true;
    } catch {
      this.#rawMode = false;
    }
  }

  #restoreTerminal(): void {
    if (!this.#screenActive) return;
    this.#screenActive = false;
    if (!this.#interactive) return;
    this.#writeRaw(terminalRestoreSequence());
    if (this.#rawMode) {
      try {
        this.#stdin.setRawMode(false);
      } catch {
        // best effort
      }
      this.#rawMode = false;
    }
    this.#logger.setMuted(false);
  }

  #writeRaw(data: string | Uint8Array): void {
    try {
      const flushed = this.#stdout.write(data);
      if (!flushed && !this.#stdoutPaused) {
        this.#stdoutPaused = true;
        this.#client?.pauseReading();
        this.#stdout.once("drain", () => {
          this.#stdoutPaused = false;
          this.#client?.resumeReading();
        });
      }
    } catch {
      // stdout is gone; the session will finish shortly
    }
  }

  #sendResize(): void {
    if (this.#closing) return;
    const size = this.#localSize();
    this.#client?.sendControl({
      v: PROTOCOL_VERSION,
      type: "resize",
      clientId: this.#clientId,
      cols: size.cols,
      rows: size.rows,
    });
  }

  #handleState(state: RelayConnectionState): void {
    this.#iceManager.onRelayState(state);
    if (state === "reconnecting") {
      this.#restoreTerminal();
      this.#logger.info("relay disconnected; reconnecting");
      this.#reducer.reset();
      // The relay forgets transport selection across reconnects, so tear the
      // P2P attempt down and let the host re-offer after the next hello.
      this.#disposeP2P("relay reconnecting");
    }
  }

  #handleFatal(error: RelayFatalError): void {
    if (error.code === "host_exited") {
      this.#finish(0, "host exited");
      return;
    }
    this.#finish(
      error.code === "unauthorized" ? 2 : error.code === "session_full" ? 3 : 1,
      `${error.code}: ${error.message}`,
    );
  }

  #handleControl(message: KnownControlMessage): void {
    switch (message.type) {
      case "host-exited": {
        const exit =
          message.exitCode === undefined || message.exitCode === null
            ? "unknown"
            : String(message.exitCode);
        const signal =
          message.signal === undefined || message.signal === null
            ? ""
            : ` signal=${message.signal}`;
        const finish = (): void => this.#finish(0, `host exited (code=${exit}${signal})`);
        // `host-exited` travels over the relay while the final PTY output may
        // still be in flight on the DataChannel. Give the P2P path a short
        // grace period so Ctrl-C/exit output is not lost on teardown.
        if (this.#peer !== null || this.#p2pReady) {
          if (this.#hostExitTimer === null) {
            this.#hostExitTimer = setTimeout(() => {
              this.#hostExitTimer = null;
              finish();
            }, 300);
          }
        } else {
          finish();
        }
        return;
      }
      case "error":
        if (message.code === "host_offline") {
          this.#logger.warn("host is offline");
        } else {
          this.#logger.warn(`relay error: ${message.code}: ${message.message}`);
        }
        return;
      case "signal": {
        if (message.kind === "offer") {
          // A new offer means the host started a new P2P attempt (initial
          // switch or the one-shot retry). Silently drop any old peer so a
          // lost relay-failure control message cannot strand the viewer.
          if (this.#peer !== null) {
            this.#disposeP2P("host restarted p2p negotiation");
          }
          this.#startViewerPeer(message.from);
        }
        this.#peer?.handleSignal({ kind: message.kind, payload: message.payload });
        return;
      }
      case "transport": {
        if (message.clientId !== this.#clientId) return;
        this.#handleTransportUpdate(message.mode, message.state, message.reason);
        return;
      }
      case "ice":
        this.#iceManager.updateFromIce(message);
        return;
      case "ice-refresh":
        this.#logger.debug("ice refresh requested");
        return;
      case "peer-joined":
      case "peer-left":
      case "host":
      case "presence":
      case "resync":
      case "ack":
      case "pause":
      case "resume":
      case "ping":
      case "pong":
      case "welcome":
      case "hello":
      case "resize":
      default:
        return;
    }
  }

  #startViewerPeer(hostClientId: string): void {
    if (this.#config.p2p === "off" || this.#closing) return;
    if (this.#peer !== null) return;
    const peer = new P2PPeer({
      label: `viewer:${hostClientId}`,
      role: "viewer",
      rtcConfig: buildNodeRtcConfig(this.#iceManager.current.servers, this.#iceTransportPolicy),
      logger: this.#logger,
      sendSignal: (kind, payload) => {
        this.#client?.sendControl({
          v: PROTOCOL_VERSION,
          type: "signal",
          to: hostClientId,
          from: this.#clientId,
          kind,
          payload,
        });
      },
      onFrame: (bytes) => this.#handleDcFrame(bytes),
      onOpen: (info) => this.#handleP2POpen(info.mode, info.detail),
      onFailed: (reason) => this.#handleP2PFailure(reason),
      onClosed: (reason) => this.#handleP2PFailure(reason),
    });
    this.#peer = peer;
    this.#logger.debug(`p2p answer path started for host ${hostClientId}`);
  }

  #handleP2POpen(mode: TransportMode, detail: string): void {
    this.#logger.debug(
      `p2p data channel open (${mode}, ${detail}); waiting for host snapshot+switch`,
    );
  }

  #handleTransportUpdate(mode: TransportMode, state: string, reason: string | undefined): void {
    if (mode.startsWith("p2p")) {
      if (state !== "ready") return;
      if (this.#peer === null) {
        this.#logger.debug("ignoring p2p transport update without a local peer");
        return;
      }
      this.#p2pReady = true;
      this.#logger.info(`p2p transport ready: ${mode}`);
      this.#flushDcBuffer();
      return;
    }
    if (mode === "relay" && (this.#p2pReady || this.#peer !== null)) {
      this.#logger.warn(`relay fallback active${reason === undefined ? "" : `: ${reason}`}`);
      this.#disposeP2P("host switched this viewer back to the relay");
    }
  }

  #handleP2PFailure(reason: string): void {
    const hadPath = this.#p2pReady || this.#peer !== null;
    this.#disposeP2P(reason);
    if (!hadPath || this.#closing) return;
    this.#logger.warn(`p2p data path failed (${reason}); continuing over relay`);
    this.#client?.sendControl({
      v: PROTOCOL_VERSION,
      type: "transport",
      clientId: this.#clientId,
      mode: "relay",
      state: "failed",
      reason: reason.slice(0, 512),
    });
  }

  #disposeP2P(reason: string): void {
    const peer = this.#peer;
    this.#peer = null;
    this.#p2pReady = false;
    this.#p2pSnapshotSeen = false;
    this.#p2pBufferOverflow = false;
    this.#dcBuffer = [];
    this.#dcBufferBytes = 0;
    peer?.close(reason);
  }

  #handleDcFrame(bytes: Uint8Array): void {
    let frame: ReturnType<typeof decodeFrame>;
    try {
      frame = decodeFrame(bytes);
    } catch (error) {
      this.#logger.debug(`invalid frame over p2p: ${formatError(error)}`);
      return;
    }
    if (frame.type !== "output") {
      this.#handleDecodedFrame(frame, false);
      return;
    }
    if (this.#p2pReady && this.#p2pSnapshotSeen) {
      this.#applyOutput(frame.seq, frame.payload, false);
      return;
    }
    if (this.#p2pBufferOverflow) return;
    this.#dcBuffer.push({ seq: frame.seq, payload: frame.payload });
    this.#dcBufferBytes += frame.payload.byteLength;
    if (this.#dcBufferBytes > DC_BUFFER_LIMIT_BYTES) {
      // Every buffered frame is at or before the switch snapshot boundary, so
      // dropping the buffer is safe once that snapshot arrives.
      this.#logger.warn("p2p pre-switch buffer overflow; requesting a fresh snapshot");
      this.#dcBuffer = [];
      this.#dcBufferBytes = 0;
      this.#p2pBufferOverflow = true;
      this.#requestResync();
    }
  }

  #flushDcBuffer(): void {
    if (!this.#p2pReady || !this.#p2pSnapshotSeen) return;
    const buffered = this.#dcBuffer;
    const overflowed = this.#p2pBufferOverflow;
    this.#dcBuffer = [];
    this.#dcBufferBytes = 0;
    this.#p2pBufferOverflow = false;
    if (overflowed) return;
    for (const output of buffered) {
      this.#applyOutput(output.seq, output.payload, false);
    }
  }

  #applyOutput(seq: number, payload: Uint8Array, viaRelay: boolean): void {
    const decision = this.#reducer.classify(seq);
    if (decision === "apply") {
      this.#writeRaw(payload);
      if (viaRelay) this.#sendAck(seq);
    } else if (decision === "gap") {
      this.#requestResync();
    }
  }

  #handleFrame(bytes: Uint8Array): void {
    let frame: ReturnType<typeof decodeFrame>;
    try {
      frame = decodeFrame(bytes);
    } catch (error) {
      this.#logger.debug(`invalid frame from relay: ${formatError(error)}`);
      return;
    }
    this.#handleDecodedFrame(frame, true);
  }

  #handleDecodedFrame(frame: ReturnType<typeof decodeFrame>, viaRelay: boolean): void {
    switch (frame.type) {
      case "snapshot_to":
        if (frame.targetId !== this.#clientId) return;
        this.#applySnapshot(frame.seq, frame.payload, viaRelay);
        return;
      case "snapshot":
        // Relay-targeted snapshots are delivered as SNAPSHOT_TO; the untargeted
        // variant is only valid on the direct P2P DataChannel.
        if (viaRelay) return;
        this.#applySnapshot(frame.seq, frame.payload, false);
        return;
      case "output":
        this.#applyOutput(frame.seq, frame.payload, viaRelay);
        return;
      case "tunnel":
      case "tunnel_to":
        this.#logger.debug("tunnel frames are not implemented in v1");
        return;
      default:
        return;
    }
  }

  /**
   * Acknowledge the last applied relay sequence.
   *
   * The relay accounts unacknowledged bytes per viewer and pauses the host
   * when a viewer falls behind; without these ACKs the pause never clears and
   * a healthy viewer is eventually dropped as a slow consumer.
   */
  #sendAck(seq: number): void {
    try {
      this.#client?.sendControl({ v: PROTOCOL_VERSION, type: "ack", seq: toU64String(seq) });
    } catch (error) {
      this.#logger.debug(`failed to send ack: ${formatError(error)}`);
    }
  }

  #applySnapshot(seq: number, payload: Uint8Array, viaRelay: boolean): void {
    const lastSeq = this.#reducer.lastSeq;
    if (isStaleSnapshot(lastSeq, seq)) {
      // A fallback/retry race can deliver an old DataChannel snapshot after a
      // newer relay snapshot; never clear the screen or move the reducer back.
      this.#logger.debug(`ignoring stale snapshot (seq=${seq}, lastSeq=${lastSeq})`);
    } else {
      this.#reducer.applySnapshot(seq);
      this.#writeRaw(CLEAR_SCREEN);
      if (payload.byteLength > 0) {
        this.#writeRaw(payload);
      }
      this.#logger.debug(
        `applied snapshot (seq=${seq}, bytes=${payload.byteLength}, ` +
          `via=${viaRelay ? "relay" : "p2p"})`,
      );
    }

    if (viaRelay) {
      // The snapshot supersedes every earlier relay byte for this viewer, even
      // when a stale snapshot payload was skipped.
      this.#sendAck(seq);
    }

    if (this.#peer !== null) {
      // The switch snapshot is a boundary for buffered DataChannel frames even
      // when the viewer already has newer state; `#flushDcBuffer` still waits
      // for the host's `transport ready` if it has not arrived yet.
      this.#p2pSnapshotSeen = true;
      this.#flushDcBuffer();
    }
  }

  #requestResync(): void {
    const now = Date.now();
    if (now - this.#lastResyncAt < RESYNC_THROTTLE_MS) return;
    this.#lastResyncAt = now;
    try {
      this.#transport?.send(encodeFrame({ type: "resync_req" }));
      this.#logger.debug("requested resync from host");
    } catch (error) {
      this.#logger.debug(`failed to request resync: ${formatError(error)}`);
    }
  }

  #finish(code: number, message?: string): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#closing = true;
    if (message !== undefined) this.#finalMessage = message;
    const resolve = this.#resolveFinished;
    this.#resolveFinished = null;
    resolve?.(code);
  }

  #cleanup(): void {
    this.#closing = true;
    if (this.#hostExitTimer !== null) {
      clearTimeout(this.#hostExitTimer);
      this.#hostExitTimer = null;
    }
    this.#restoreTerminal();
    if (this.#finalMessage !== null) {
      this.#logger.info(this.#finalMessage);
    }
    if (this.#resizeHandler !== null) {
      process.removeListener("SIGWINCH", this.#resizeHandler);
      try {
        (this.#stdout as SizedWriteStream).removeListener("resize", this.#resizeHandler);
      } catch {
        // best effort
      }
      this.#resizeHandler = null;
    }
    if (this.#stdinHandler !== null) {
      try {
        this.#stdin.removeListener("data", this.#stdinHandler);
      } catch {
        // best effort
      }
      this.#stdinHandler = null;
    }
    for (const { signal, handler } of this.#signalHandlers) {
      process.removeListener(signal, handler);
    }
    this.#signalHandlers = [];
    if (this.#exitHandler !== null) {
      process.removeListener("exit", this.#exitHandler);
      this.#exitHandler = null;
    }
    this.#disposeP2P("session closing");
    this.#client?.stop();
    this.#client = null;
    this.#iceManager.dispose();
    this.#transport = null;
  }
}
