/**
 * Host session: owns the PTY, mirrors it into a headless xterm, streams
 * OUTPUT frames to the relay, and serves per-viewer SNAPSHOT_TO frames.
 *
 * Phase 3 only uses the relay transport; the `Transport` seam is kept so
 * Phase 4 can swap in P2P/TURN data paths without rewriting this class.
 */

import { randomUUID } from "node:crypto";

import {
  decodeFrame,
  encodeFrame,
  type IceServerConfig,
  type IceTransportPolicy,
  isTerminalSizeWithinLimits,
  type KnownControlMessage,
  MAX_DATACHANNEL_MESSAGE_BYTES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type TransportMode,
  type WelcomeMessage,
} from "@limccn/tokimeki-protocol";

import type { HostConfig } from "../config.js";
import { formatError, type Logger } from "../logger.js";
import { TerminalMirror } from "../terminal/mirror.js";
import { ModeTracker } from "../terminal/mode-tracker.js";
import { ByteRing } from "../terminal/ring-buffer.js";
import { buildCapabilities } from "../transport/capabilities.js";
import { buildNodeRtcConfig, resolveIceTransportPolicy } from "../transport/ice.js";
import { P2PPeer } from "../transport/p2p-peer.js";
import { RelayClient } from "../transport/relay-client.js";
import { RelayTransport } from "../transport/relay-transport.js";
import type { RelayFatalError } from "../transport/relay-types.js";
import { RouteSelector } from "../transport/route-selector.js";
import type { Transport } from "../transport/types.js";
import { HostPty, type PtyExitInfo } from "./host-pty.js";
import { buildPtyCommand } from "./pty-command.js";
import {
  resolveResize,
  shouldApplyResize,
  sizesEqual,
  type TerminalSize,
} from "./resize-policy.js";

export type HostCommandKind = "claude" | "pi" | "run";

export interface HostSessionDeps {
  readonly logger: Logger;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly platform?: NodeJS.Platform;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

const LOCAL_STDOUT_PAUSE = "local-stdout";
const RELAY_BUFFER_PAUSE = "relay-buffered";
const SNAPSHOT_QUIET_MS = 50;
const SNAPSHOT_MAX_WAIT_MS = 150;
const SNAPSHOT_TICK_MS = 20;
const RING_BYTES = 256 * 1024;
const RELAY_HIGH_WATER = 1_048_576;
const RELAY_LOW_WATER = 262_144;
const P2P_HIGH_WATER = 4_194_304;
const SNAPSHOT_PAUSE = "snapshot";
const RESYNC_THROTTLE_MS = 500;

/**
 * Output frames are always split to the SCTP interop budget so the same frame
 * can travel over the relay or a DataChannel without re-encoding.
 */
const OUTPUT_PAYLOAD_MAX = MAX_DATACHANNEL_MESSAGE_BYTES - 16;

interface HostP2PLink {
  readonly peer: P2PPeer;
  mode: TransportMode | null;
  ready: boolean;
  sentFrames: number;
  inputSeen: boolean;
}

interface HeldOutput {
  readonly seq: number;
  readonly frame: Uint8Array;
}

type SizedWriteStream = NodeJS.WriteStream & { columns?: number; rows?: number };

function readTerminalSize(stream: NodeJS.WriteStream, fallback: TerminalSize): TerminalSize {
  const sized = stream as SizedWriteStream;
  const cols = typeof sized.columns === "number" ? sized.columns : fallback.cols;
  const rows = typeof sized.rows === "number" ? sized.rows : fallback.rows;
  return {
    cols: Math.max(1, cols),
    rows: Math.max(1, rows),
  };
}

function splitChunk(chunk: Buffer, maxPayload: number): Buffer[] {
  if (chunk.byteLength <= maxPayload) return [chunk];
  const parts: Buffer[] = [];
  for (let offset = 0; offset < chunk.byteLength; offset += maxPayload) {
    parts.push(chunk.subarray(offset, Math.min(offset + maxPayload, chunk.byteLength)));
  }
  return parts;
}

function truncateUtf8Tail(data: Buffer, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (data.byteLength <= maxBytes) return data.toString("utf8");
  const slice = data.subarray(data.byteLength - maxBytes);
  let offset = 0;
  while (offset < slice.byteLength && offset < 3 && ((slice[offset] ?? 0) & 0xc0) === 0x80) {
    offset += 1;
  }
  return slice.subarray(offset).toString("utf8");
}

/** Session banner lines (never includes a token unless it was generated). */
export function formatSessionInfo(config: HostConfig, viewerCount: number): string[] {
  const lines = [
    `session: ${config.session}`,
    `relay: ${config.relayUrl}`,
    `viewers: ${viewerCount}`,
  ];
  if (config.sessionTokenGenerated) {
    lines.push(`session token (generated, save it): ${config.sessionToken}`);
  } else {
    lines.push("session token: provided via TOKIMEKI_SESSION_TOKEN");
  }
  return lines.map((line) => `[tokimeki] ${line}`);
}

export async function runHostSession(
  config: HostConfig,
  command: string,
  args: readonly string[],
  kind: HostCommandKind,
  deps: HostSessionDeps,
): Promise<number> {
  const session = new HostSession(config, command, args, kind, deps);
  return session.run();
}

class HostSession {
  readonly #config: HostConfig;
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #kind: HostCommandKind;
  readonly #logger: Logger;
  readonly #stdin: NodeJS.ReadStream;
  readonly #stdout: NodeJS.WriteStream;
  readonly #stderr: NodeJS.WriteStream;
  readonly #platform: NodeJS.Platform;
  readonly #cwd: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #clientId = `host-${randomUUID()}`;

  #pty: HostPty | null = null;
  #mirror: TerminalMirror | null = null;
  #client: RelayClient | null = null;
  #transport: Transport | null = null;

  readonly #tracker = new ModeTracker();
  readonly #ring = new ByteRing(RING_BYTES);

  #startupSize: TerminalSize = { cols: 80, rows: 24 };
  #localSize: TerminalSize = { cols: 80, rows: 24 };
  #latestSize: TerminalSize = { cols: 80, rows: 24 };

  readonly #viewers = new Set<string>();
  readonly #viewerSizes = new Map<string, TerminalSize>();
  readonly #pendingSnapshots = new Set<string>();
  readonly #resyncAt = new Map<string, number>();
  #pendingSnapshotSince = 0;
  #snapshotTimer: NodeJS.Timeout | null = null;
  #snapshotInFlight = false;

  #nextSeq = 0;
  #lastAssignedSeq = -1;
  #holdDepth = 0;
  #holdQueue: HeldOutput[] = [];
  #lastOutputAt = Date.now();

  #iceServers: readonly IceServerConfig[] = [];
  #iceTransportPolicy: IceTransportPolicy;
  readonly #p2pLinks = new Map<string, HostP2PLink>();
  readonly #pendingP2PSwitches = new Set<string>();

  #relayBackpressureTimer: NodeJS.Timeout | null = null;

  #rawMode = false;
  #stdinHandler: ((chunk: Buffer | string) => void) | null = null;
  #resizeHandler: (() => void) | null = null;
  #signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];
  #exitHandler: (() => void) | null = null;

  #closing = false;
  #finished = false;
  #resolveFinished: ((code: number) => void) | null = null;
  readonly #finishedPromise: Promise<number>;

  constructor(
    config: HostConfig,
    command: string,
    args: readonly string[],
    kind: HostCommandKind,
    deps: HostSessionDeps,
  ) {
    this.#config = config;
    this.#iceTransportPolicy = config.iceTransportPolicy;
    this.#command = command;
    this.#args = args;
    this.#kind = kind;
    this.#logger = deps.logger;
    this.#stdin = deps.stdin ?? process.stdin;
    this.#stdout = deps.stdout ?? process.stdout;
    this.#stderr = deps.stderr ?? process.stderr;
    this.#platform = deps.platform ?? process.platform;
    this.#cwd = deps.cwd ?? process.cwd();
    this.#env = deps.env ?? process.env;
    this.#finishedPromise = new Promise<number>((resolve) => {
      this.#resolveFinished = resolve;
    });
  }

  async run(): Promise<number> {
    this.#startupSize = readTerminalSize(this.#stdout, { cols: 80, rows: 24 });
    this.#localSize = this.#startupSize;
    this.#latestSize = this.#startupSize;

    try {
      this.#createPty();
    } catch (error) {
      this.#logger.error(`failed to start PTY: ${formatError(error)}`);
      return 1;
    }

    this.#writeSessionInfo();
    this.#installLocalTerminal();
    this.#connectRelay();

    const code = await this.#finishedPromise;
    this.#cleanup();
    return code;
  }

  #writeSessionInfo(): void {
    for (const line of formatSessionInfo(this.#config, this.#viewers.size)) {
      try {
        this.#stderr.write(`${line}\n`);
      } catch {
        // stderr may be gone during shutdown
      }
    }
  }

  #createPty(): void {
    const spec = buildPtyCommand(this.#command, this.#args, {
      env: this.#env,
      platform: this.#platform,
      term: this.#config.term,
      colorterm: this.#config.colorterm,
      piTuiMode: this.#config.piTuiMode,
      isClaude: this.#kind === "claude",
      isPi: this.#kind === "pi",
    });
    const initial = resolveResize({
      policy: this.#config.resizePolicy,
      local: this.#startupSize,
      startup: this.#startupSize,
      pinned: this.#config.ptySize,
      viewers: [],
      latest: this.#latestSize,
    });
    this.#latestSize = initial;
    this.#pty = new HostPty(
      {
        command: spec.command,
        args: spec.args,
        cwd: this.#cwd,
        cols: initial.cols,
        rows: initial.rows,
        name: this.#config.term,
        env: spec.env,
        onData: (chunk) => this.#handlePtyData(chunk),
        onExit: (info) => this.#handlePtyExit(info),
      },
      this.#platform,
    );
    this.#mirror = new TerminalMirror({
      cols: this.#pty.cols,
      rows: this.#pty.rows,
      scrollback: this.#config.scrollbackLines,
      onReply: (data) => {
        // With at least one viewer the real viewer terminal answers queries;
        // otherwise the host's headless mirror must answer so the TUI does not
        // hang. Never both.
        if (this.#viewers.size === 0) {
          this.#pty?.write(data);
        }
      },
    });
    this.#logger.info(`PTY started: ${spec.display}`);
  }

  #installLocalTerminal(): void {
    this.#stdinHandler = (chunk) => {
      // Design contract: non-TTY local input (pm2/systemd/redirection) is
      // ignored; only the local terminal shares control with the viewers.
      if (this.#stdin.isTTY !== true) return;
      const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      this.#pty?.write(data);
    };
    if (this.#stdin.isTTY === true) {
      try {
        this.#stdin.setRawMode(true);
        this.#rawMode = true;
      } catch {
        this.#rawMode = false;
      }
    }
    try {
      this.#stdin.resume();
      this.#stdin.on("data", this.#stdinHandler);
    } catch {
      // stdin may not be readable (detached process)
    }

    this.#resizeHandler = () => this.#handleLocalResize();
    process.on("SIGWINCH", this.#resizeHandler);
    try {
      (this.#stdout as SizedWriteStream).on("resize", this.#resizeHandler);
    } catch {
      // non-TTY streams do not resize
    }

    const onSignal = (signal: NodeJS.Signals, code: number) => {
      const handler = () => {
        this.#logger.info(`received ${signal}; shutting down`);
        this.#pty?.kill();
        this.#finish(code);
      };
      this.#signalHandlers.push({ signal, handler });
      process.once(signal, handler);
    };
    onSignal("SIGINT", 130);
    onSignal("SIGTERM", 143);

    this.#exitHandler = () => {
      // Synchronous best effort: restore the local terminal and kill the tree.
      if (this.#rawMode) {
        try {
          this.#stdin.setRawMode(false);
        } catch {
          // best effort
        }
      }
      this.#pty?.kill();
      this.#client?.stop();
    };
    process.once("exit", this.#exitHandler);
  }

  #connectRelay(): void {
    const client = new RelayClient({
      url: this.#config.websocketUrl,
      headers: {
        "X-Tokimeki-Master": this.#config.masterToken,
        "X-Tokimeki-Session": this.#config.sessionToken,
      },
      role: "host",
      session: this.#config.session,
      clientId: this.#clientId,
      cols: this.#pty?.cols ?? this.#startupSize.cols,
      rows: this.#pty?.rows ?? this.#startupSize.rows,
      heartbeatSeconds: this.#config.heartbeatSeconds,
      capabilities: buildCapabilities({
        p2p: this.#config.p2p === "auto",
        snapshotMaxBytes: this.#config.snapshotMaxBytes,
      }),
      logger: this.#logger,
    });
    this.#client = client;
    client.onWelcome((welcome) => this.#handleWelcome(welcome));
    client.onMessage((message) => this.#handleControl(message));
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
  }

  #handleWelcome(welcome: WelcomeMessage): void {
    if (!welcome.hostOnline) {
      this.#logger.warn("relay reports host offline while this host is connected");
    }
    this.#iceServers = welcome.iceServers;
    this.#iceTransportPolicy = resolveIceTransportPolicy(
      this.#config.iceTransportPolicy,
      welcome.transportPolicy,
    );
    this.#logger.debug(
      `ice provider: ${welcome.iceProvider} ` +
        `(servers=${welcome.iceServers.length}, transportPolicy=${welcome.transportPolicy})`,
    );
    for (const client of welcome.clients) {
      if (client.role !== undefined && client.role !== "viewer") continue;
      this.#viewers.add(client.clientId);
      this.#scheduleSnapshot(client.clientId);
      const link = this.#p2pLinks.get(client.clientId);
      if (link !== undefined && link.ready && link.peer.isOpen && link.mode !== null) {
        // Relay reconnection resets the attachment's recorded transport mode;
        // re-announce and refresh the snapshot for an already-open DataChannel.
        this.#pendingP2PSwitches.add(client.clientId);
        this.#scheduleSnapshot(client.clientId);
      } else {
        this.#startP2P(client.clientId);
      }
    }
    this.#logger.info(`viewers: ${this.#viewers.size}`);
  }

  #handleControl(message: KnownControlMessage): void {
    switch (message.type) {
      case "peer-joined":
        this.#viewers.add(message.clientId);
        this.#logger.info(`viewer joined: ${message.clientId} (viewers=${this.#viewers.size})`);
        this.#scheduleSnapshot(message.clientId);
        this.#startP2P(message.clientId);
        return;
      case "peer-left":
        this.#closeP2PLink(message.clientId, "viewer left");
        this.#viewers.delete(message.clientId);
        this.#viewerSizes.delete(message.clientId);
        this.#pendingSnapshots.delete(message.clientId);
        this.#resyncAt.delete(message.clientId);
        this.#logger.info(`viewer left: ${message.clientId} (viewers=${this.#viewers.size})`);
        this.#applyResize();
        return;
      case "resize": {
        if (message.clientId === this.#clientId) {
          // Defense in depth: the relay only synthesizes resize for viewers,
          // but a self-resize must never register the host as its own viewer.
          return;
        }
        if (!this.#viewers.has(message.clientId)) {
          this.#viewers.add(message.clientId);
        }
        const size: TerminalSize = { cols: message.cols, rows: message.rows };
        this.#viewerSizes.set(message.clientId, size);
        this.#latestSize = size;
        this.#applyResize();
        this.#scheduleSnapshot(message.clientId);
        return;
      }
      case "resync":
        if (message.clientId !== undefined) {
          this.#logger.debug(`viewer ${message.clientId} requested a resync; scheduling snapshot`);
          this.#scheduleResync(message.clientId);
        } else {
          this.#logger.debug("viewer requested a resync; scheduling snapshots");
          this.#snapshotAll();
        }
        return;
      case "pause":
        this.#logger.debug(`relay flow control pause for ${message.clientId}`);
        this.#pty?.pause(`relay:${message.clientId}`);
        return;
      case "resume":
        this.#logger.debug(`relay flow control resume for ${message.clientId}`);
        this.#pty?.resume(`relay:${message.clientId}`);
        return;
      case "ice":
      case "ice-refresh":
        this.#logger.debug(
          `ice provider: ${message.type === "ice" ? message.iceProvider : "refresh"}`,
        );
        return;
      case "transport":
        this.#logger.debug(`transport ${message.clientId}: ${message.mode}/${message.state}`);
        if (message.mode === "relay") {
          this.#fallbackToRelay(
            message.clientId,
            message.reason ?? "viewer reported a relay transport",
          );
        }
        return;
      case "signal": {
        const link = this.#p2pLinks.get(message.from);
        if (link !== undefined) {
          link.peer.handleSignal({ kind: message.kind, payload: message.payload });
        }
        return;
      }
      case "host":
      case "presence":
      case "ping":
      case "pong":
      case "welcome":
      case "hello":
      case "error":
      case "host-exited":
      default:
        return;
    }
  }

  #startP2P(clientId: string): void {
    if (this.#config.p2p === "off" || this.#closing) return;
    if (this.#p2pLinks.has(clientId)) return;
    const peer = new P2PPeer({
      label: `host:${clientId}`,
      role: "host",
      rtcConfig: buildNodeRtcConfig(this.#iceServers, this.#iceTransportPolicy),
      logger: this.#logger,
      sendSignal: (kind, payload) => {
        this.#client?.sendControl({
          v: PROTOCOL_VERSION,
          type: "signal",
          to: clientId,
          from: this.#clientId,
          kind,
          payload,
        });
      },
      onFrame: (bytes) => this.#handleFrame(bytes, clientId),
      onOpen: (info) => this.#handleP2POpen(clientId, info.mode, info.detail),
      onFailed: (reason) => this.#fallbackToRelay(clientId, reason),
      onClosed: (reason) => this.#fallbackToRelay(clientId, reason),
    });
    this.#p2pLinks.set(clientId, {
      peer,
      mode: null,
      ready: false,
      sentFrames: 0,
      inputSeen: false,
    });
    peer.onDrain(() => this.#pty?.resume(`p2p:${clientId}`));
    peer.startOffer();
    this.#logger.debug(`p2p offer started for viewer ${clientId}`);
  }

  #handleP2POpen(clientId: string, mode: TransportMode, detail: string): void {
    const link = this.#p2pLinks.get(clientId);
    if (link === undefined || this.#closing) return;
    link.mode = mode;
    this.#pendingP2PSwitches.add(clientId);
    this.#logger.debug(`p2p data channel open for ${clientId} (${mode}, ${detail})`);
    // The switch itself happens after a fresh snapshot has been sent over the
    // relay, so the viewer never has to apply pre-switch DC output blindly.
    this.#scheduleSnapshot(clientId);
  }

  #activateP2P(clientId: string, snapshotSeq: number): void {
    const link = this.#p2pLinks.get(clientId);
    if (link === undefined || link.mode === null || !link.peer.isOpen) {
      this.#logger.debug(`p2p switch skipped for ${clientId} (link no longer open)`);
      return;
    }
    link.ready = true;
    this.#client?.sendControl({
      v: PROTOCOL_VERSION,
      type: "transport",
      clientId,
      mode: link.mode,
      state: "ready",
    });
    this.#logger.info(
      `p2p ready for ${clientId}: ${link.mode} (snapshot seq ${snapshotSeq}); ` +
        "relay output suppressed for this viewer",
    );
  }

  #fallbackToRelay(clientId: string, reason: string): void {
    const link = this.#p2pLinks.get(clientId);
    if (link === undefined) return;
    this.#p2pLinks.delete(clientId);
    this.#pendingP2PSwitches.delete(clientId);
    link.peer.close(reason);
    this.#pty?.resume(`p2p:${clientId}`);
    if (this.#closing) return;
    this.#logger.warn(`p2p unavailable for ${clientId} (${reason}); using relay`);
    this.#client?.sendControl({
      v: PROTOCOL_VERSION,
      type: "transport",
      clientId,
      mode: "relay",
      state: "failed",
      reason: reason.slice(0, 512),
    });
    // Resume relay delivery with a known-good screen boundary.
    this.#scheduleSnapshot(clientId);
  }

  #closeP2PLink(clientId: string, reason: string): void {
    const link = this.#p2pLinks.get(clientId);
    if (link === undefined) return;
    this.#p2pLinks.delete(clientId);
    this.#pendingP2PSwitches.delete(clientId);
    link.peer.close(reason);
    this.#pty?.resume(`p2p:${clientId}`);
  }

  #isP2PReady(clientId: string): boolean {
    const link = this.#p2pLinks.get(clientId);
    return link !== undefined && link.ready && link.peer.isOpen;
  }

  #handleFatal(error: RelayFatalError): void {
    this.#logger.error(`${error.code}: ${error.message}`);
    const code = error.code === "unauthorized" ? 2 : error.code === "session_full" ? 3 : 1;
    this.#finish(code);
  }

  #handleFrame(bytes: Uint8Array, p2pClientId?: string): void {
    let frame: ReturnType<typeof decodeFrame>;
    try {
      frame = decodeFrame(bytes);
    } catch (error) {
      this.#logger.warn(
        `invalid frame from ${p2pClientId === undefined ? "relay" : "p2p"}: ${formatError(error)}`,
      );
      return;
    }
    switch (frame.type) {
      case "input":
        if (p2pClientId !== undefined) {
          const link = this.#p2pLinks.get(p2pClientId);
          if (link !== undefined && !link.inputSeen) {
            link.inputSeen = true;
            this.#logger.info(`p2p input received over data channel from ${p2pClientId}`);
          }
        }
        this.#pty?.write(frame.payload);
        return;
      case "resync_req":
        if (p2pClientId !== undefined) {
          this.#scheduleResync(p2pClientId);
        } else {
          this.#snapshotAll();
        }
        return;
      case "tunnel":
      case "tunnel_to":
        this.#logger.debug("tunnel frames are not implemented in v1");
        return;
      default:
        return;
    }
  }

  #handlePtyData(chunk: Buffer): void {
    this.#ring.push(chunk);
    this.#tracker.apply(chunk);
    this.#lastOutputAt = Date.now();
    this.#writeLocal(chunk);

    for (const part of splitChunk(chunk, OUTPUT_PAYLOAD_MAX)) {
      const seq = this.#nextSeq;
      this.#nextSeq += 1;
      this.#lastAssignedSeq = seq;
      this.#mirror?.write(part);
      this.#sendOutput(seq, part);
    }
  }

  #sendOutput(seq: number, payload: Uint8Array): void {
    let frame: Uint8Array;
    try {
      frame = encodeFrame({ type: "output", seq, payload });
    } catch (error) {
      this.#logger.warn(`failed to encode output frame: ${formatError(error)}`);
      return;
    }
    if (this.#holdDepth > 0) {
      this.#holdQueue.push({ seq, frame });
    } else {
      this.#routeOutput(seq, frame);
    }
    this.#checkRelayBackpressure();
  }

  /**
   * Fan one encoded OUTPUT frame out to the transports that still need it.
   *
   * The relay only carries output while at least one viewer is on the relay
   * path; viewers with an active P2P link receive the frame over their own
   * DataChannel.
   */
  #routeOutput(seq: number, frame: Uint8Array): void {
    let relayNeeded = false;
    for (const viewer of this.#viewers) {
      if (!this.#isP2PReady(viewer)) {
        relayNeeded = true;
        break;
      }
    }
    if (relayNeeded) {
      this.#transport?.send(frame);
    }
    for (const [clientId, link] of this.#p2pLinks) {
      if (!link.ready || !link.peer.isOpen) continue;
      if (!link.peer.send(frame)) {
        this.#logger.warn(`p2p send rejected output seq ${seq} for ${clientId}`);
        this.#fallbackToRelay(clientId, "data channel send failed");
        continue;
      }
      if (link.sentFrames === 0) {
        this.#logger.info(`p2p output started on data channel for ${clientId} (seq ${seq})`);
      }
      link.sentFrames += 1;
      if (link.peer.bufferedAmount > P2P_HIGH_WATER) {
        this.#pty?.pause(`p2p:${clientId}`);
      }
    }
  }

  #writeLocal(chunk: Buffer): void {
    if (this.#stdout.isTTY !== true) return;
    try {
      const flushed = this.#stdout.write(chunk);
      if (!flushed) {
        this.#pty?.pause(LOCAL_STDOUT_PAUSE);
        this.#stdout.once("drain", () => this.#pty?.resume(LOCAL_STDOUT_PAUSE));
      }
    } catch {
      // best effort; relay output still flows
    }
  }

  #checkRelayBackpressure(): void {
    if (this.#relayBackpressureTimer !== null) return;
    if ((this.#client?.bufferedAmount ?? 0) <= RELAY_HIGH_WATER) return;
    this.#pty?.pause(RELAY_BUFFER_PAUSE);
    this.#relayBackpressureTimer = setInterval(() => {
      if ((this.#client?.bufferedAmount ?? 0) > RELAY_LOW_WATER) return;
      if (this.#relayBackpressureTimer !== null) {
        clearInterval(this.#relayBackpressureTimer);
        this.#relayBackpressureTimer = null;
      }
      this.#pty?.resume(RELAY_BUFFER_PAUSE);
    }, 50);
  }

  #handleLocalResize(): void {
    if (this.#closing) return;
    const size = readTerminalSize(this.#stdout, this.#startupSize);
    if (sizesEqual(size, this.#localSize)) return;
    this.#localSize = size;
    this.#latestSize = size;
    this.#applyResize();
  }

  #applyResize(): void {
    const pty = this.#pty;
    if (pty === null) return;
    const next = resolveResize({
      policy: this.#config.resizePolicy,
      local: this.#localSize,
      startup: this.#startupSize,
      pinned: this.#config.ptySize,
      viewers: this.#viewerSizes.values(),
      latest: this.#latestSize,
    });
    const current: TerminalSize = { cols: pty.cols, rows: pty.rows };
    if (!isTerminalSizeWithinLimits(next.cols, next.rows)) {
      this.#logger.warn(`ignoring resize outside the cell limit: ${next.cols}x${next.rows}`);
      return;
    }
    if (!shouldApplyResize(current, next)) return;
    pty.resize(next.cols, next.rows);
    this.#mirror?.resize(next.cols, next.rows);
    this.#logger.debug(`PTY resized to ${next.cols}x${next.rows}`);
  }

  #snapshotAll(): void {
    for (const clientId of this.#viewers) {
      this.#scheduleSnapshot(clientId);
    }
  }

  #scheduleResync(clientId: string): void {
    const now = Date.now();
    const last = this.#resyncAt.get(clientId) ?? 0;
    if (now - last < RESYNC_THROTTLE_MS) {
      return;
    }
    this.#resyncAt.set(clientId, now);
    this.#scheduleSnapshot(clientId);
  }

  #scheduleSnapshot(clientId: string): void {
    if (this.#closing) return;
    this.#pendingSnapshots.add(clientId);
    if (this.#pendingSnapshots.size === 1) {
      this.#pendingSnapshotSince = Date.now();
    }
    this.#ensureSnapshotTimer();
  }

  #ensureSnapshotTimer(): void {
    if (this.#snapshotTimer !== null || this.#closing) return;
    this.#snapshotTimer = setTimeout(() => {
      this.#snapshotTimer = null;
      void this.#snapshotTick();
    }, SNAPSHOT_TICK_MS);
  }

  async #snapshotTick(): Promise<void> {
    if (this.#closing) return;
    if (this.#pendingSnapshots.size > 0 && !this.#snapshotInFlight) {
      const now = Date.now();
      const quiet = now - this.#lastOutputAt >= SNAPSHOT_QUIET_MS;
      const maxed = now - this.#pendingSnapshotSince >= SNAPSHOT_MAX_WAIT_MS;
      if (!this.#tracker.synchronizedOutput && (quiet || maxed)) {
        this.#snapshotInFlight = true;
        try {
          await this.#sendSnapshots();
        } finally {
          this.#snapshotInFlight = false;
        }
      }
    }
    if (this.#pendingSnapshots.size > 0) {
      this.#ensureSnapshotTimer();
    }
  }

  async #sendSnapshots(): Promise<void> {
    const targets = [...this.#pendingSnapshots];
    this.#pendingSnapshots.clear();
    if (targets.length === 0) return;

    this.#pty?.pause(SNAPSHOT_PAUSE);
    this.#holdDepth += 1;
    try {
      // No PTY data can arrive while paused, so after flush the mirror and the
      // sequence counter describe exactly the same output prefix.
      await this.#mirror?.flush();
      const boundary = this.#lastAssignedSeq;
      const replay = this.#tracker.replaySequence();
      const payloadText = this.#serializeSnapshot(replay);
      const payload = Buffer.from(payloadText, "utf8");
      let snapshotSeq = boundary;
      if (boundary < 0) {
        snapshotSeq = 0;
        if (this.#nextSeq === 0) this.#nextSeq = 1;
      }
      for (const target of targets) {
        try {
          const frame = encodeFrame({
            type: "snapshot_to",
            targetId: target,
            seq: snapshotSeq,
            payload,
          });
          this.#transport?.send(frame);
          if (this.#pendingP2PSwitches.delete(target)) {
            this.#activateP2P(target, snapshotSeq);
          }
        } catch (error) {
          this.#logger.warn(`failed to send snapshot to ${target}: ${formatError(error)}`);
        }
      }
      this.#logger.debug(
        `sent snapshot (seq=${snapshotSeq}, bytes=${payload.byteLength}, viewers=${targets.length})`,
      );
    } finally {
      this.#holdDepth = Math.max(0, this.#holdDepth - 1);
      if (this.#holdDepth === 0) {
        const queued = this.#holdQueue;
        this.#holdQueue = [];
        for (const { seq, frame } of queued) {
          this.#routeOutput(seq, frame);
        }
      }
      this.#pty?.resume(SNAPSHOT_PAUSE);
    }
  }

  #snapshotPayloadLimit(): number {
    // SNAPSHOT_TO: 1 type + 1 targetLen + target + 8 seq bytes. Reserve room
    // for the longest legal client id.
    return Math.max(256, Math.min(this.#config.snapshotMaxBytes, MAX_FRAME_BYTES - 80));
  }

  #serializeSnapshot(replay: string): string {
    const limit = this.#snapshotPayloadLimit();
    const replayBytes = Buffer.byteLength(replay);
    const budget = Math.max(0, limit - replayBytes);
    let text = "";
    try {
      text = this.#mirror?.serialize(this.#config.scrollbackLines) ?? "";
    } catch (error) {
      this.#logger.warn(`snapshot serialization failed: ${formatError(error)}`);
      text = "";
    }
    if (text === "" && this.#ring.length > 0) {
      text = truncateUtf8Tail(this.#ring.toBuffer(), budget);
    }
    if (Buffer.byteLength(text) > budget) {
      try {
        text = this.#mirror?.serialize(0) ?? "";
      } catch {
        text = "";
      }
    }
    if (Buffer.byteLength(text) > budget) {
      text = truncateUtf8Tail(this.#ring.toBuffer(), budget);
    }
    if (Buffer.byteLength(text) > budget) {
      text = truncateUtf8Tail(Buffer.from(text, "utf8"), budget);
    }
    return text + replay;
  }

  #handlePtyExit(info: PtyExitInfo): void {
    if (this.#closing) return;
    this.#logger.info(
      `PTY exited (code=${info.exitCode}${info.signal === undefined ? "" : `, signal=${info.signal}`})`,
    );
    const hostExited = {
      v: PROTOCOL_VERSION,
      type: "host-exited" as const,
      exitCode: info.exitCode,
      ...(info.signal === undefined ? {} : { signal: String(info.signal) }),
    };
    this.#client?.sendControl(hostExited);
    this.#logger.info(
      "hint: this conversation can be resumed with --resume/--continue where supported",
    );
    setTimeout(() => this.#finish(info.exitCode >= 0 ? info.exitCode : 1), 150);
  }

  #finish(code: number): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#closing = true;
    const resolve = this.#resolveFinished;
    this.#resolveFinished = null;
    resolve?.(code);
  }

  #cleanup(): void {
    this.#closing = true;
    for (const clientId of [...this.#p2pLinks.keys()]) {
      this.#closeP2PLink(clientId, "host session closing");
    }
    this.#pendingP2PSwitches.clear();
    if (this.#snapshotTimer !== null) {
      clearTimeout(this.#snapshotTimer);
      this.#snapshotTimer = null;
    }
    if (this.#relayBackpressureTimer !== null) {
      clearInterval(this.#relayBackpressureTimer);
      this.#relayBackpressureTimer = null;
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
    if (this.#rawMode) {
      try {
        this.#stdin.setRawMode(false);
      } catch {
        // best effort
      }
      this.#rawMode = false;
    }
    this.#client?.stop();
    this.#client = null;
    this.#transport = null;
    this.#pty?.kill();
    this.#pty = null;
    this.#mirror?.dispose();
    this.#mirror = null;
  }
}
