/**
 * Host session: owns the PTY, mirrors it into a headless xterm, streams
 * OUTPUT frames to the relay, and serves per-viewer SNAPSHOT_TO frames.
 *
 * Phase 3 only uses the relay transport; the `Transport` seam is kept so
 * Phase 4 can swap in P2P/TURN data paths without rewriting this class.
 */

import { randomUUID } from "node:crypto";

import {
  type Capabilities,
  decodeFrame,
  encodeFrame,
  type IceTransportPolicy,
  isTerminalSizeWithinLimits,
  type KnownControlMessage,
  MAX_DATACHANNEL_MESSAGE_BYTES,
  MAX_FRAGMENT_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type TransportMode,
  TUNNEL_OUTPUT_PAYLOAD_MAX_BYTES,
  type TunnelKeyMode,
  type WelcomeMessage,
} from "@limccn/tokimeki-protocol";
import type { CliMode } from "../cli-mode.js";
import { buildClientDescriptor, formatViewerConfigJson } from "../client-info.js";
import { buildHostAuthHeaders, type HostConfig } from "../config.js";
import {
  type CliEventWriter,
  eventConnectionState,
  eventTransport,
  mapRelayErrorCode,
} from "../events.js";
import { inviteKeyLabel } from "../invite.js";
import { formatError, type Logger } from "../logger.js";
import { createPasscodeVerifier, type PasscodeVerifier } from "../passcode.js";
import { TerminalMirror } from "../terminal/mirror.js";
import { ModeTracker } from "../terminal/mode-tracker.js";
import { ByteRing } from "../terminal/ring-buffer.js";
import {
  LocalViewport,
  type MenuAction,
  type MenuModel,
  type ViewportRelayState,
  type ViewportStatus,
  type ViewportTransport,
} from "../terminal/viewport/index.js";
import {
  buildCapabilities,
  supportsFragmentation,
  supportsViewport,
} from "../transport/capabilities.js";
import { buildNodeRtcConfig, resolveIceTransportPolicy } from "../transport/ice.js";
import { type IceConfig, IceConfigManager } from "../transport/ice-config.js";
import { P2PPeer } from "../transport/p2p-peer.js";
import { canRetryP2P, P2P_RETRY_DELAY_MS } from "../transport/p2p-retry.js";
import { RelayClient } from "../transport/relay-client.js";
import { RelayTransport } from "../transport/relay-transport.js";
import type { RelayFatalError } from "../transport/relay-types.js";
import { RouteSelector } from "../transport/route-selector.js";
import {
  buildTunnelOffer,
  matchingTunnelCapability,
  selectTunnelFec,
  type TunnelFecMode,
  tunnelCapabilitiesCompatible,
} from "../transport/tunnel/capability.js";
import { TUNNEL_FEC_OUTPUT_PAYLOAD_MAX_BYTES } from "../transport/tunnel/fec.js";
import { TunnelTransport } from "../transport/tunnel/tunnel-transport.js";
import type { Transport } from "../transport/types.js";
import { resolveWindowMode } from "../window-policy.js";
import { HostPty, type PtyExitInfo } from "./host-pty.js";
import { buildPtyCommand } from "./pty-command.js";
import {
  resolveResize,
  shouldApplyResize,
  sizesEqual,
  type TerminalSize,
} from "./resize-policy.js";

export type HostCommandKind = "claude" | "pi" | "run" | "custom";

export interface HostSessionDeps {
  readonly logger: Logger;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly platform?: NodeJS.Platform;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Daemon mode suppresses the startup banner and emits structured events. */
  readonly mode?: CliMode;
  readonly events?: CliEventWriter;
  /** Hosted anonymous invite URL (capability secret, memory only). */
  readonly hostedInviteUrl?: string;
  /** Invoked once the first relay welcome has been processed. */
  readonly onWelcome?: () => void;
}

const LOCAL_STDOUT_PAUSE = "local-stdout";
const RELAY_BUFFER_PAUSE = "relay-buffered";
const SNAPSHOT_QUIET_MS = 50;
const SNAPSHOT_MAX_WAIT_MS = 150;
const SNAPSHOT_TICK_MS = 20;
const RING_BYTES = 256 * 1024;
const RELAY_HIGH_WATER = 1_048_576;
const RELAY_LOW_WATER = 262_144;
/**
 * Listener snapshots share the host's relay socket with viewer output. Stop
 * enqueueing them once this much data is already buffered so a slow relay or
 * many listeners cannot push the shared socket toward the viewer pause mark.
 */
const LISTENER_RELAY_BUFFER_BUDGET = 524_288;
const P2P_HIGH_WATER = 4_194_304;
const SNAPSHOT_PAUSE = "snapshot";
const RESYNC_THROTTLE_MS = 500;

/**
 * Output frames are always split to the SCTP interop budget so the same frame
 * can travel over the relay or a reliable DataChannel without re-encoding.
 * When the TUN profile is enabled, the payload is capped one tunnel record
 * smaller so the whole OUTPUT frame fits inside a single AEAD record.
 */
const OUTPUT_PAYLOAD_MAX = MAX_DATACHANNEL_MESSAGE_BYTES - 16;
const TUNNEL_HIGH_WATER = 524_288;

interface HostP2PLink {
  readonly peer: P2PPeer;
  /**
   * TUN profile endpoint when the viewer advertised a compatible capability.
   * Null means this link uses the v1 reliable DataChannel path.
   */
  tunnel: TunnelTransport | null;
  tunnelKeyMode: TunnelKeyMode | null;
  /** Negotiated parity sender policy for this link (null when no tunnel). */
  tunnelFec: TunnelFecMode | null;
  mode: TransportMode | null;
  ready: boolean;
  sentFrames: number;
  inputSeen: boolean;
  supportsFragmentation: boolean;
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

/** Mask a secret for the local menu unless the user explicitly reveals it. */
export function maskSecretToken(value: string): string {
  if (value.length <= 8) return "*".repeat(Math.max(4, value.length));
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** Session banner lines (never includes the relay master token). */
export function formatSessionInfo(config: HostConfig, viewerCount: number): string[] {
  const window = config.ptySize ?? config.windowSize;
  const lines = [
    `session: ${config.session}`,
    `relay: ${config.relayUrl}`,
    `viewers: ${viewerCount}`,
    `window: ${window.cols}x${window.rows}`,
    `viewer config (secret, copy as one line): ${formatViewerConfigJson(config)}`,
  ];
  if (config.inviteKey !== "off") {
    lines.push(`hint: press ${inviteKeyLabel(config.inviteKey)} to show this again`);
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
  readonly #mode: CliMode;
  readonly #events: CliEventWriter | null;
  readonly #hostedInviteUrl: string | null;
  readonly #onWelcome: (() => void) | undefined;
  #readyEmitted = false;

  /** Derived once per process; reconnect hellos reuse the same verifier. */
  #passcodeVerifierCache: PasscodeVerifier | null = null;
  #pty: HostPty | null = null;
  #mirror: TerminalMirror | null = null;
  #viewport: LocalViewport | null = null;
  #client: RelayClient | null = null;
  #transport: Transport | null = null;
  #relayState: ViewportRelayState = "connecting";
  /** Logs captured by the viewport sink and replayed after restore. */
  readonly #deferredLogs: string[] = [];

  readonly #tracker = new ModeTracker();
  readonly #ring = new ByteRing(RING_BYTES);

  #startupSize: TerminalSize = { cols: 80, rows: 24 };
  #localSize: TerminalSize = { cols: 80, rows: 24 };
  #latestSize: TerminalSize = { cols: 80, rows: 24 };
  /**
   * Fixed TUI window gate. When true, viewer/local resizes never reach the PTY;
   * `#viewportEnabled` (local TTY only) additionally renders it locally.
   */
  readonly #fixedGeometryEnabled: boolean;
  #fixedSize: TerminalSize;
  readonly #viewportEnabled: boolean;
  /** Session-scoped pinned size chosen from the connection menu. */
  #menuPinnedSize: TerminalSize | null = null;
  readonly #menuResizeState: {
    cols: number;
    rows: number;
    policy: string;
    hint?: string;
  } = { cols: 80, rows: 24, policy: "latest" };

  readonly #viewers = new Set<string>();
  /**
   * Read-only listeners are tracked separately from viewers: they never enter
   * resize, P2P, flow-control, or ACK accounting and only receive periodic
   * full `SNAPSHOT_TO` frames.
   */
  readonly #listeners = new Set<string>();
  #listenerTimer: NodeJS.Timeout | null = null;
  #listenerSnapshotInFlight = false;
  readonly #viewerSizes = new Map<string, TerminalSize>();
  /** Viewers that cannot render the fixed grid locally (query responders). */
  readonly #nonViewportViewers = new Set<string>();
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

  readonly #iceManager: IceConfigManager;
  #iceTransportPolicy: IceTransportPolicy;
  readonly #p2pLinks = new Map<string, HostP2PLink>();
  readonly #pendingP2PSwitches = new Set<string>();
  readonly #fragmentationViewers = new Set<string>();
  /**
   * Viewers whose `hello`/`peer-joined` capabilities match this build's TUN
   * dialect, mapped to the parity policy negotiated for that link. Only these
   * viewers get an unreliable DataChannel and AEAD/ARQ.
   */
  readonly #tunnelViewers = new Map<string, TunnelFecMode>();
  readonly #p2pRetryUsed = new Set<string>();
  readonly #p2pRetryTimers = new Map<string, NodeJS.Timeout>();
  #p2pRetriesInFlight = 0;

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
    this.#mode = deps.mode ?? "interactive";
    this.#events = deps.events ?? null;
    this.#hostedInviteUrl = deps.hostedInviteUrl ?? null;
    this.#onWelcome = deps.onWelcome;
    this.#fixedSize = config.ptySize ?? config.windowSize;
    this.#menuResizeState.cols = this.#fixedSize.cols;
    this.#menuResizeState.rows = this.#fixedSize.rows;
    this.#menuResizeState.policy = config.resizePolicy;
    this.#fixedGeometryEnabled =
      resolveWindowMode({
        mode: config.windowMode,
        tuiCommands: config.windowTuiCommands,
        command,
        platform: this.#platform,
      }) === "on";
    this.#viewportEnabled = this.#fixedGeometryEnabled && this.#stdout.isTTY === true;
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
    this.#startViewport();
    this.#installLocalTerminal();
    this.#connectRelay();

    const code = await this.#finishedPromise;
    this.#cleanup();
    return code;
  }

  #writeSessionInfo(): void {
    // Daemon mode must not bypass logger redaction with the sessionToken-bearing
    // viewer config; the harness gets ready/status events and explicit sharing
    // happens through the local menu instead.
    if (this.#mode === "daemon") return;
    for (const line of formatSessionInfo(this.#config, this.#viewers.size)) {
      try {
        this.#stderr.write(`${line}\n`);
      } catch {
        // stderr may be gone during shutdown
      }
    }
  }

  #startViewport(): void {
    if (this.#viewport === null) return;
    this.#viewport.start();
    this.#logger.setSink((line) => {
      this.#viewport?.appendLog(line);
      if (this.#config.logLevel !== "debug" || this.#config.logViewRows === 0) {
        if (this.#deferredLogs.length >= 256) this.#deferredLogs.shift();
        this.#deferredLogs.push(line);
      }
    });
    this.#updateViewportStatus();
  }

  #flushDeferredLogs(): void {
    if (this.#deferredLogs.length === 0) return;
    const lines = this.#deferredLogs.splice(0);
    try {
      for (const line of lines) this.#stderr.write(`${line}\n`);
    } catch {
      // stderr may be gone during shutdown
    }
  }

  #statusModel(): ViewportStatus {
    return {
      role: "host",
      session: this.#config.session,
      relayState: this.#relayState,
      viewers: this.#viewers.size,
      transport: this.#transportLabel(),
      ...(this.#config.inviteKey === "off"
        ? {}
        : { inviteHint: `${inviteKeyLabel(this.#config.inviteKey).toLowerCase()}:menu` }),
    };
  }

  #transportLabel(): ViewportTransport {
    for (const link of this.#p2pLinks.values()) {
      if (link.ready && link.mode !== null) return link.mode;
    }
    return "relay";
  }

  #shouldAnswerTerminalQueries(): boolean {
    // Without a fixed window the host keeps the legacy rule: with any viewer,
    // the viewer's real terminal answers.
    if (!this.#fixedGeometryEnabled) return this.#viewers.size === 0;
    if (this.#viewers.size === 0) return true;
    // New viewers suppress their mirror replies; legacy viewers answer through
    // their real terminal, so the host must not answer as well.
    return this.#nonViewportViewers.size === 0;
  }

  #updateViewportStatus(): void {
    this.#viewport?.setStatus(this.#statusModel());
  }

  #menuModel(revealToken: boolean): MenuModel {
    const token = revealToken
      ? this.#config.sessionToken
      : maskSecretToken(this.#config.sessionToken);
    const window = this.#fixedGeometryEnabled
      ? this.#fixedSize
      : this.#pty === null
        ? this.#config.windowSize
        : { cols: this.#pty.cols, rows: this.#pty.rows };
    const lines = [
      `relay: ${this.#config.relayUrl}`,
      ...(this.#config.namespace === null ? [] : [`namespace: ${this.#config.namespace}`]),
      `session: ${this.#config.session}`,
      `session token (viewer capability): ${token}`,
      `viewers: ${this.#viewers.size}   listeners: ${this.#listeners.size}`,
      `transport: ${this.#transportLabel()}   relay: ${this.#relayState}`,
      `window: ${window.cols}x${window.rows} (${this.#config.resizePolicy})`,
      ...(this.#fixedGeometryEnabled
        ? ["fixed window: live resize requires a host restart (deferred to v1.8)"]
        : []),
      ...(this.#hostedInviteUrl === null ? [] : ["anonymous invite URL: available"]),
    ];
    const items = [
      { id: "status", label: "Refresh status" },
      { id: "show-token", label: "Show/hide session token" },
      { id: "copy-config", label: "Copy viewer config (OSC 52)" },
      ...(this.#hostedInviteUrl === null
        ? []
        : [{ id: "copy-invite", label: "Copy anonymous invite URL (OSC 52)" }]),
      ...(this.#config.logLevel === "debug" && this.#config.logViewRows > 0
        ? [{ id: "open-logs", label: "Open log view (F11)" }]
        : []),
      ...(this.#fixedGeometryEnabled ? [] : [{ id: "resize", label: "Resize hosted window" }]),
    ];
    return { title: "TOKIMEKI CONNECTION", lines, items };
  }

  #handleMenuAction(action: MenuAction): void {
    if (action.type === "resize") {
      this.#applyMenuResize({ cols: action.cols, rows: action.rows });
    }
  }

  /**
   * Apply a window size chosen from the F12 menu through the existing resize
   * pipeline. Fixed windows update the session-scoped pinned size; `min` may
   * still be compressed by viewers; `pinned` updates the in-memory pin.
   */
  #applyMenuResize(next: TerminalSize): void {
    if (!isTerminalSizeWithinLimits(next.cols, next.rows)) {
      this.#logger.warn(`ignoring resize outside the cell limit: ${next.cols}x${next.rows}`);
      return;
    }
    if (this.#fixedGeometryEnabled) {
      // Viewers learn the fixed grid from the host hello capabilities, and v1
      // has no wire message to update them live. Applying a new PTY size would
      // desync existing viewers' mirrors, so fixed-grid live resize is deferred
      // to the v1.8 protocol work; the menu item is not offered in this mode.
      this.#logger.warn(
        "fixed-window resize is not applied live; restart the host with a new TOKIMEKI_WINDOW_SIZE (deferred to v1.8)",
      );
      return;
    }
    if (this.#config.resizePolicy === "pinned") {
      this.#menuPinnedSize = next;
    }
    this.#latestSize = next;
    this.#applyResize();
    this.#logger.info(
      `menu resize requested ${next.cols}x${next.rows} (policy ${this.#config.resizePolicy})`,
    );
    if (this.#config.resizePolicy === "min") {
      this.#logger.info("min policy may compress the window to fit every writable viewer");
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
    const initial = this.#fixedGeometryEnabled
      ? this.#fixedSize
      : resolveResize({
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
        // With a local viewport the host mirror must answer unless a legacy
        // viewer's real terminal is still responsible for replies.
        if (this.#shouldAnswerTerminalQueries()) {
          this.#pty?.write(data);
        }
      },
    });
    if (this.#viewportEnabled) {
      const inviteKey = this.#config.inviteKey;
      this.#menuResizeState.cols = this.#pty.cols;
      this.#menuResizeState.rows = this.#pty.rows;
      this.#viewport = new LocalViewport({
        mirror: this.#mirror,
        tracker: this.#tracker,
        stdout: this.#stdout,
        logViewRows: this.#config.logLevel === "debug" ? this.#config.logViewRows : 0,
        status: this.#statusModel(),
        onInput: (data) => this.#pty?.write(data),
        ...(inviteKey === "off"
          ? {}
          : {
              menu: {
                key: inviteKey,
                role: "host",
                getModel: ({ revealToken }) => this.#menuModel(revealToken),
                onAction: (action) => this.#handleMenuAction(action),
                copyText: formatViewerConfigJson(this.#config),
                ...(this.#hostedInviteUrl === null ? {} : { inviteUrl: this.#hostedInviteUrl }),
                resize: this.#menuResizeState,
              },
            }),
      });
    }
    this.#logger.info(`PTY started: ${spec.display}`);
  }

  #installLocalTerminal(): void {
    this.#stdinHandler = (chunk) => {
      // Design contract: non-TTY local input (pm2/systemd/redirection) is
      // ignored; only the local terminal shares control with the viewers.
      if (this.#stdin.isTTY !== true) return;
      const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      if (this.#viewport !== null) {
        this.#viewport.handleInput(data);
        return;
      }
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
      this.#viewport?.restoreSync();
      this.#flushDeferredLogs();
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

  #passcodeVerifier(): PasscodeVerifier | null {
    if (this.#config.passcode === null) {
      return null;
    }
    if (this.#passcodeVerifierCache === null) {
      this.#passcodeVerifierCache = createPasscodeVerifier(this.#config.passcode, {
        sessionId: this.#config.session,
      });
    }
    return this.#passcodeVerifierCache;
  }

  #connectRelay(): void {
    const passcodeVerifier = this.#passcodeVerifier();
    const client = new RelayClient({
      url: this.#config.websocketUrl,
      headers: {
        // Host JWTs and static namespace tokens travel in the same host
        // header; the relay derives the namespace from the token and never
        // trusts a client header. The CLI never sends Authorization.
        ...buildHostAuthHeaders(this.#config.hostToken),
        "X-Tokimeki-Session": this.#config.sessionToken,
      },
      ...(passcodeVerifier === null
        ? {}
        : { passcodeVerifier, requireSessionSecurityPasscode: true }),
      role: "host",
      session: this.#config.session,
      clientId: this.#clientId,
      cols: this.#pty?.cols ?? this.#startupSize.cols,
      rows: this.#pty?.rows ?? this.#startupSize.rows,
      heartbeatSeconds: this.#config.heartbeatSeconds,
      client: buildClientDescriptor({ platform: this.#platform }),
      capabilities: buildCapabilities({
        p2p: this.#config.p2p === "auto",
        snapshotMaxBytes: this.#config.snapshotMaxBytes,
        sessionSecurity: this.#config.passcode !== null,
        ...(this.#config.tunnel === "auto" ? { tunnelKeyMode: this.#config.tunnelKeyMode } : {}),
        ...(this.#fixedGeometryEnabled
          ? {
              display: {
                modes: this.#viewportEnabled ? ["fixed-grid", "viewport"] : ["fixed-grid"],
                fixed: this.#fixedSize,
                logPanel: true,
                terminalQueries: "host",
              },
            }
          : {}),
      }),
      logger: this.#logger,
    });
    this.#client = client;
    client.onWelcome((welcome) => this.#handleWelcome(welcome));
    client.onMessage((message) => this.#handleControl(message));
    client.onState((state) => {
      this.#relayState = state;
      this.#updateViewportStatus();
      this.#iceManager.onRelayState(state);
      this.#events?.status({
        connection: {
          state: eventConnectionState(state),
          transport: eventTransport(this.#transportLabel()),
        },
        configured: true,
        relay: this.#config.relayUrl,
        ...(this.#config.namespace === null ? {} : { namespace: this.#config.namespace }),
        session: this.#config.session,
      });
    });
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
    this.#iceManager.updateFromWelcome(welcome);
    this.#iceTransportPolicy = resolveIceTransportPolicy(
      this.#config.iceTransportPolicy,
      welcome.transportPolicy,
    );
    this.#logger.debug(
      `ice provider: ${welcome.iceProvider} ` +
        `(servers=${welcome.iceServers.length}, transportPolicy=${welcome.transportPolicy})`,
    );
    // `welcome.clients` is authoritative after a relay reconnect: drop
    // listeners that left while the host was disconnected before re-adding the
    // currently connected set below.
    this.#listeners.clear();
    this.#nonViewportViewers.clear();
    this.#stopListenerTimer();
    for (const client of welcome.clients) {
      if (client.role === "listener") {
        this.#listeners.add(client.clientId);
        continue;
      }
      if (client.role !== undefined && client.role !== "viewer") continue;
      this.#viewers.add(client.clientId);
      if (supportsViewport(client.capabilities)) {
        this.#nonViewportViewers.delete(client.clientId);
      } else {
        this.#nonViewportViewers.add(client.clientId);
      }
      this.#updateTunnelViewer(client.clientId, client.capabilities);
      this.#scheduleSnapshot(client.clientId);
      const link = this.#p2pLinks.get(client.clientId);
      if (link?.ready === true && link.peer.isOpen && link.mode !== null) {
        // Relay reconnection resets the attachment's recorded transport mode;
        // re-announce and refresh the snapshot for an already-open DataChannel.
        this.#pendingP2PSwitches.add(client.clientId);
        this.#scheduleSnapshot(client.clientId);
      } else {
        this.#startP2P(client.clientId);
      }
    }
    if (this.#listeners.size > 0) {
      // A reconnected host must not leave listeners waiting for the first
      // periodic tick; send the current screen immediately.
      void this.#sendListenerSnapshots();
      this.#startListenerTimer();
    }
    this.#logger.info(`viewers: ${this.#viewers.size}`);
    if (this.#listeners.size > 0) {
      this.#logger.info(`listeners: ${this.#listeners.size}`);
    }
    this.#updateViewportStatus();
    this.#onWelcome?.();
    if (!this.#readyEmitted) {
      this.#readyEmitted = true;
      this.#events?.ready({
        command: "host",
        role: "host",
        relay: this.#config.relayUrl,
        ...(this.#config.namespace === null ? {} : { namespace: this.#config.namespace }),
        session: this.#config.session,
        transport: eventTransport(this.#transportLabel()),
        pid: process.pid,
      });
    }
  }

  #handleControl(message: KnownControlMessage): void {
    switch (message.type) {
      case "peer-joined": {
        if (message.role === "listener") {
          // Listeners only get periodic snapshots; no P2P, resize, or entry in
          // the viewer sets.
          this.#listeners.add(message.clientId);
          this.#logger.info(
            `listener joined: ${message.clientId} (listeners=${this.#listeners.size})`,
          );
          void this.#sendListenerSnapshots();
          this.#startListenerTimer();
          return;
        }
        this.#viewers.add(message.clientId);
        if (supportsViewport(message.capabilities)) {
          this.#nonViewportViewers.delete(message.clientId);
        } else {
          this.#nonViewportViewers.add(message.clientId);
        }
        const fragments = supportsFragmentation(message.capabilities);
        if (fragments) {
          this.#fragmentationViewers.add(message.clientId);
        } else {
          this.#fragmentationViewers.delete(message.clientId);
        }
        this.#updateTunnelViewer(message.clientId, message.capabilities);
        const existingLink = this.#p2pLinks.get(message.clientId);
        if (existingLink !== undefined) {
          existingLink.supportsFragmentation = fragments;
        }
        this.#logger.info(`viewer joined: ${message.clientId} (viewers=${this.#viewers.size})`);
        this.#updateViewportStatus();
        this.#scheduleSnapshot(message.clientId);
        this.#startP2P(message.clientId);
        return;
      }
      case "peer-left":
        if (this.#listeners.delete(message.clientId)) {
          this.#logger.info(
            `listener left: ${message.clientId} (listeners=${this.#listeners.size})`,
          );
          if (this.#listeners.size === 0) {
            this.#stopListenerTimer();
          }
          return;
        }
        this.#closeP2PLink(message.clientId, "viewer left");
        this.#viewers.delete(message.clientId);
        this.#viewerSizes.delete(message.clientId);
        this.#nonViewportViewers.delete(message.clientId);
        this.#pendingSnapshots.delete(message.clientId);
        this.#resyncAt.delete(message.clientId);
        this.#fragmentationViewers.delete(message.clientId);
        this.#tunnelViewers.delete(message.clientId);
        this.#clearP2PRetry(message.clientId);
        this.#logger.info(`viewer left: ${message.clientId} (viewers=${this.#viewers.size})`);
        this.#updateViewportStatus();
        this.#applyResize();
        return;
      case "resize": {
        if (message.clientId === this.#clientId) {
          // Defense in depth: the relay only synthesizes resize for viewers,
          // but a self-resize must never register the host as its own viewer.
          return;
        }
        if (this.#listeners.has(message.clientId)) {
          // Listeners never drive PTY sizing.
          return;
        }
        if (!this.#viewers.has(message.clientId)) {
          this.#viewers.add(message.clientId);
          // Capability is unknown until peer-joined; be conservative so the
          // host does not race a legacy viewer's terminal query replies.
          this.#nonViewportViewers.add(message.clientId);
        }
        const size: TerminalSize = { cols: message.cols, rows: message.rows };
        this.#viewerSizes.set(message.clientId, size);
        if (this.#fixedGeometryEnabled) {
          // Fixed TUI window: viewer dimensions are diagnostics only. Never
          // rewrite #latestSize or resize the PTY.
          this.#logger.debug(
            `viewer ${message.clientId} reported ${size.cols}x${size.rows}; ` +
              `fixed window ${this.#fixedSize.cols}x${this.#fixedSize.rows}`,
          );
          return;
        }
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
        this.#iceManager.updateFromIce(message);
        this.#logger.debug(`ice provider: ${message.iceProvider}`);
        return;
      case "ice-refresh":
        this.#logger.debug("ice refresh requested");
        return;
      case "transport":
        this.#logger.debug(`transport ${message.clientId}: ${message.mode}/${message.state}`);
        if (message.mode === "relay" && message.state === "failed") {
          this.#handleP2PUnavailable(
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
      default:
        return;
    }
  }

  #updateTunnelViewer(clientId: string, capabilities: Capabilities | undefined): void {
    if (this.#config.tunnel !== "auto") {
      this.#tunnelViewers.delete(clientId);
      return;
    }
    if (capabilities === undefined) {
      // `welcome.clients` on pre-F1 relays omits capabilities. Keep a known
      // peer's eligibility across a host relay reconnect; peer-joined carries
      // the authoritative capabilities for new viewers.
      return;
    }
    const peerCapability = matchingTunnelCapability(capabilities);
    if (tunnelCapabilitiesCompatible(peerCapability, this.#config.tunnelKeyMode)) {
      const localFec: TunnelFecMode = this.#config.tunnelFec === "xor" ? "xor" : "none";
      this.#tunnelViewers.set(clientId, selectTunnelFec(localFec, peerCapability));
      return;
    }
    this.#tunnelViewers.delete(clientId);
    this.#logger.debug(`tunnel not negotiated for ${clientId}: capability mismatch`);
  }

  #startP2P(clientId: string, iceConfig?: IceConfig): void {
    if (this.#config.p2p === "off" || this.#closing) return;
    if (this.#p2pLinks.has(clientId)) return;
    const useTunnel = this.#config.tunnel === "auto" && this.#tunnelViewers.has(clientId);
    const tunnelFec = this.#tunnelViewers.get(clientId) ?? "none";
    const peer = new P2PPeer({
      label: `host:${clientId}`,
      role: "host",
      rtcConfig: buildNodeRtcConfig(
        (iceConfig ?? this.#iceManager.current).servers,
        this.#iceTransportPolicy,
      ),
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
      onOpen: (info) => this.#handleP2POpen(clientId, info.mode, info.detail, info.lan),
      onFailed: (reason) => this.#handleP2PUnavailable(clientId, reason),
      onClosed: (reason) => this.#fallbackToRelay(clientId, reason),
      ...(useTunnel
        ? {
            // TUN profile: unordered with no SCTP retransmissions. The tunnel
            // supplies ordering and reliability; v1 frames must never use this
            // channel.
            dataChannelConfig: { unordered: true, maxRetransmits: 0 },
            offerMetadata: {
              tunnel: buildTunnelOffer(this.#config.tunnelKeyMode, tunnelFec),
            },
          }
        : {}),
    });

    let tunnel: TunnelTransport | null = null;
    if (useTunnel) {
      try {
        tunnel = new TunnelTransport({
          role: "host",
          sessionId: this.#config.session,
          sessionToken: this.#config.sessionToken,
          keyMode: this.#config.tunnelKeyMode,
          secret: this.#config.tunnelSecret,
          fec: tunnelFec,
          logger: this.#logger,
          sendFrame: (bytes) => peer.send(bytes),
          onFrame: (bytes) => this.#handleFrame(bytes, clientId, true),
          onFailure: (reason) => this.#handleTunnelFailure(clientId, reason),
        });
        tunnel.onDrain(() => this.#pty?.resume(`tunnel:${clientId}`));
      } catch (error) {
        this.#logger.warn(`tunnel setup failed for ${clientId}: ${formatError(error)}`);
        peer.close("tunnel setup failed");
        this.#client?.sendControl({
          v: PROTOCOL_VERSION,
          type: "transport",
          clientId,
          mode: "relay",
          state: "failed",
          reason: "tunnel setup failed",
        });
        this.#scheduleSnapshot(clientId);
        return;
      }
    }

    this.#p2pLinks.set(clientId, {
      peer,
      tunnel,
      tunnelKeyMode: tunnel === null ? null : this.#config.tunnelKeyMode,
      tunnelFec: tunnel === null ? null : tunnelFec,
      mode: null,
      ready: false,
      sentFrames: 0,
      inputSeen: false,
      supportsFragmentation: this.#fragmentationViewers.has(clientId),
    });
    peer.onDrain(() => this.#pty?.resume(`p2p:${clientId}`));
    peer.startOffer();
    this.#logger.debug(
      `p2p offer started for viewer ${clientId}${tunnel === null ? "" : " (tunnel)"}`,
    );
  }

  #handleP2POpen(clientId: string, mode: TransportMode, detail: string, lan: boolean): void {
    const link = this.#p2pLinks.get(clientId);
    if (link === undefined || this.#closing) return;
    link.mode = mode;
    this.#pendingP2PSwitches.add(clientId);
    this.#logger.debug(
      `p2p data channel open for ${clientId} (${mode}, ${detail}, lan=${lan ? "yes" : "no"})`,
    );
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
    this.#updateViewportStatus();
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
    if (link.tunnel !== null) {
      this.#logger.info(
        `tunnel ready for ${clientId} ` +
          `(keyMode=${link.tunnelKeyMode ?? "session-token"}, fec=${link.tunnelFec ?? "none"})`,
      );
    }
  }

  #fallbackToRelay(clientId: string, reason: string, scheduleSnapshot = true): void {
    const link = this.#p2pLinks.get(clientId);
    if (link === undefined) return;
    this.#p2pLinks.delete(clientId);
    this.#pendingP2PSwitches.delete(clientId);
    link.tunnel?.dispose();
    link.peer.close(reason);
    this.#pty?.resume(`p2p:${clientId}`);
    this.#pty?.resume(`tunnel:${clientId}`);
    this.#updateViewportStatus();
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
    if (scheduleSnapshot) {
      // Resume relay delivery with a known-good screen boundary.
      this.#scheduleSnapshot(clientId);
    }
  }

  #handleTunnelFailure(clientId: string, reason: string): void {
    const stats = this.#p2pLinks.get(clientId)?.tunnel?.stats;
    if (stats !== undefined) {
      this.#logger.debug(
        `tunnel stats for ${clientId}: sent=${stats.sentRecords} ` +
          `received=${stats.receivedRecords} retransmits=${stats.retransmits} ` +
          `decryptFailures=${stats.decryptFailures} fecGroups=${stats.fecGroupsSent} ` +
          `fecRecovered=${stats.fecRecovered} fecDropped=${stats.fecParityDropped}`,
      );
    }
    this.#logger.warn(`tunnel unavailable for ${clientId} (${reason}); using relay`);
    this.#fallbackToRelay(clientId, `tunnel: ${reason}`);
  }

  #handleP2PUnavailable(
    clientId: string,
    reason: string,
    options?: { readonly scheduleSnapshot?: boolean },
  ): void {
    const link = this.#p2pLinks.get(clientId);
    const retryable = canRetryP2P({
      hasLink: link !== undefined,
      linkReady: link?.ready ?? false,
      p2pEnabled: this.#config.p2p === "auto",
      closing: this.#closing,
      alreadyUsed: this.#p2pRetryUsed.has(clientId),
      inFlight: this.#p2pRetriesInFlight,
    });

    this.#fallbackToRelay(clientId, reason, options?.scheduleSnapshot ?? true);
    if (!retryable || this.#closing) return;

    this.#p2pRetryUsed.add(clientId);
    this.#p2pRetriesInFlight += 1;
    this.#logger.info(`p2p retry scheduled for ${clientId} (${reason})`);
    const timer = setTimeout(() => {
      this.#p2pRetryTimers.delete(clientId);
      void this.#retryP2P(clientId);
    }, P2P_RETRY_DELAY_MS);
    timer.unref?.();
    this.#p2pRetryTimers.set(clientId, timer);
  }

  async #retryP2P(clientId: string): Promise<void> {
    try {
      if (this.#closing || !this.#viewers.has(clientId) || this.#p2pLinks.has(clientId)) {
        return;
      }
      const config = await this.#iceManager.refreshForRetry();
      if (config === null) {
        this.#logger.debug(`p2p retry skipped for ${clientId}: no alternate ICE config`);
        return;
      }
      if (this.#closing || !this.#viewers.has(clientId) || this.#p2pLinks.has(clientId)) {
        return;
      }
      this.#logger.info(`p2p retry starting for ${clientId} (provider=${config.provider})`);
      this.#startP2P(clientId, config);
    } catch (error) {
      this.#logger.warn(`p2p retry failed for ${clientId}: ${formatError(error)}`);
    } finally {
      this.#p2pRetriesInFlight = Math.max(0, this.#p2pRetriesInFlight - 1);
    }
  }

  #clearP2PRetry(clientId: string): void {
    const timer = this.#p2pRetryTimers.get(clientId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#p2pRetryTimers.delete(clientId);
      this.#p2pRetriesInFlight = Math.max(0, this.#p2pRetriesInFlight - 1);
    }
    this.#p2pRetryUsed.delete(clientId);
  }

  #closeP2PLink(clientId: string, reason: string): void {
    const link = this.#p2pLinks.get(clientId);
    if (link === undefined) return;
    this.#p2pLinks.delete(clientId);
    this.#pendingP2PSwitches.delete(clientId);
    link.tunnel?.dispose();
    link.peer.close(reason);
    this.#pty?.resume(`p2p:${clientId}`);
    this.#pty?.resume(`tunnel:${clientId}`);
    this.#updateViewportStatus();
  }

  #isP2PReady(clientId: string): boolean {
    const link = this.#p2pLinks.get(clientId);
    return link?.ready === true && link.peer.isOpen;
  }

  #handleFatal(error: RelayFatalError): void {
    this.#logger.error(`${error.code}: ${error.message}`);
    const code = error.code === "unauthorized" ? 2 : error.code === "session_full" ? 3 : 1;
    this.#events?.error({
      code: mapRelayErrorCode(error.code),
      message: error.message,
      retryable: false,
      exitCode: code,
    });
    this.#finish(code);
  }

  #handleFrame(bytes: Uint8Array, p2pClientId?: string, viaTunnel = false): void {
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
      case "tunnel": {
        if (p2pClientId === undefined) {
          // v1 relay paths must never forward TUNNEL frames.
          this.#logger.debug("ignoring tunnel frame from the relay");
          return;
        }
        if (viaTunnel) {
          // Tunnel plaintext is one complete terminal frame; nesting is out
          // of contract and must not feed the ARQ state recursively.
          this.#logger.debug("ignoring nested tunnel frame");
          return;
        }
        const link = this.#p2pLinks.get(p2pClientId);
        if (link?.tunnel != null) {
          link.tunnel.receive(frame.payload);
        } else {
          this.#logger.debug(`ignoring tunnel frame from ${p2pClientId} without an active tunnel`);
        }
        return;
      }
      case "tunnel_to":
        this.#logger.debug("ignoring unsupported TUNNEL_TO frame");
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

    for (const part of splitChunk(chunk, this.#outputPayloadMax())) {
      const seq = this.#nextSeq;
      this.#nextSeq += 1;
      this.#lastAssignedSeq = seq;
      this.#mirror?.write(part);
      this.#sendOutput(seq, part);
    }
  }

  /**
   * When the TUN profile is enabled, keep every OUTPUT frame inside one AEAD
   * record. With XOR parity enabled the payload is capped further so the
   * parity record for a full group (metadata + max frame) still fits one AEAD
   * record. The same split is safe on the relay (slightly smaller frames), so
   * one frame can travel either path without re-encoding.
   */
  #outputPayloadMax(): number {
    if (this.#config.tunnel !== "auto" || this.#config.p2p === "off") {
      return OUTPUT_PAYLOAD_MAX;
    }
    return this.#config.tunnelFec === "xor"
      ? TUNNEL_FEC_OUTPUT_PAYLOAD_MAX_BYTES
      : TUNNEL_OUTPUT_PAYLOAD_MAX_BYTES;
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
      const sent = link.tunnel === null ? link.peer.send(frame) : link.tunnel.send(frame);
      if (!sent) {
        this.#logger.warn(`p2p send rejected output seq ${seq} for ${clientId}`);
        this.#fallbackToRelay(clientId, "data channel send failed");
        continue;
      }
      if (link.sentFrames === 0) {
        this.#logger.info(
          `p2p output started on ${link.tunnel === null ? "data channel" : "tunnel"} ` +
            `for ${clientId} (seq ${seq})`,
        );
      }
      link.sentFrames += 1;
      if (link.tunnel !== null) {
        if (link.tunnel.pendingBytes > TUNNEL_HIGH_WATER) {
          this.#pty?.pause(`tunnel:${clientId}`);
        }
      } else if (link.peer.bufferedAmount > P2P_HIGH_WATER) {
        this.#pty?.pause(`p2p:${clientId}`);
      }
    }
  }

  #writeLocal(chunk: Buffer): void {
    if (this.#viewportEnabled) return;
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
    if (this.#fixedGeometryEnabled) {
      // The local viewport (when present) is relaid out from this size; the
      // hosted PTY keeps its session-level fixed geometry.
      this.#viewport?.resizeLocal(size);
      this.#logger.debug(
        `local terminal resized to ${size.cols}x${size.rows}; fixed window unchanged`,
      );
      return;
    }
    this.#latestSize = size;
    this.#applyResize();
  }

  #applyResize(): void {
    const pty = this.#pty;
    if (pty === null) return;
    const next = this.#fixedGeometryEnabled
      ? this.#fixedSize
      : resolveResize({
          policy: this.#config.resizePolicy,
          local: this.#localSize,
          startup: this.#startupSize,
          pinned: this.#menuPinnedSize ?? this.#config.ptySize,
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
    this.#menuResizeState.cols = next.cols;
    this.#menuResizeState.rows = next.rows;
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
      let directFrame: Uint8Array | null = null;
      for (const target of targets) {
        const link = this.#p2pLinks.get(target);
        // The TUN profile runs on an unreliable DataChannel; snapshots stay on
        // the relay path (they are the recovery boundary, not tunnel data).
        const canSendDirect =
          link?.peer.isOpen === true && link.supportsFragmentation && link.tunnel === null;
        if (canSendDirect) {
          try {
            directFrame ??= encodeFrame({
              type: "snapshot",
              seq: snapshotSeq,
              payload,
            });
            if (link.peer.sendFragmentableFrame(directFrame)) {
              const fragments =
                directFrame.byteLength <= MAX_DATACHANNEL_MESSAGE_BYTES
                  ? 1
                  : Math.ceil(directFrame.byteLength / MAX_FRAGMENT_CHUNK_BYTES);
              this.#logger.debug(
                `p2p snapshot sent (target=${target}, seq=${snapshotSeq}, ` +
                  `bytes=${payload.byteLength}, fragments=${fragments})`,
              );
              if (this.#pendingP2PSwitches.delete(target)) {
                this.#activateP2P(target, snapshotSeq);
              }
              continue;
            }
          } catch (error) {
            this.#logger.warn(`failed to encode p2p snapshot for ${target}: ${formatError(error)}`);
          }
          // The DataChannel is not usable for this snapshot; fall back without
          // scheduling a second snapshot (the relay frame below is sent now).
          this.#fallbackToRelay(target, "p2p snapshot send failed", false);
        }

        try {
          const frame = encodeFrame({
            type: "snapshot_to",
            targetId: target,
            seq: snapshotSeq,
            payload,
          });
          this.#transport?.send(frame);
          this.#logger.debug(
            `relay snapshot sent (target=${target}, seq=${snapshotSeq}, ` +
              `bytes=${payload.byteLength})`,
          );
          if (this.#pendingP2PSwitches.delete(target)) {
            this.#activateP2P(target, snapshotSeq);
          }
        } catch (error) {
          this.#logger.warn(`failed to send snapshot to ${target}: ${formatError(error)}`);
        }
      }
      this.#logger.debug(
        `snapshot pass complete (seq=${snapshotSeq}, bytes=${payload.byteLength}, ` +
          `viewers=${targets.length})`,
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

  #startListenerTimer(): void {
    if (this.#listenerTimer !== null || this.#listeners.size === 0 || this.#closing) return;
    const timer = setInterval(() => {
      void this.#sendListenerSnapshots();
    }, this.#config.listenerSnapshotMs);
    timer.unref?.();
    this.#listenerTimer = timer;
  }

  #stopListenerTimer(): void {
    if (this.#listenerTimer === null) return;
    clearInterval(this.#listenerTimer);
    this.#listenerTimer = null;
  }

  /**
   * Send one full ANSI snapshot to every listener over the relay.
   *
   * Deliberately independent from the viewer snapshot path: the PTY is not
   * paused, no output is held, and no viewer seq/ACK state is touched. If a
   * listener falls behind, the frame is still encoded and handed to the relay;
   * the relay drops it and the next tick supersedes it.
   */
  async #sendListenerSnapshots(): Promise<void> {
    if (this.#closing || this.#listeners.size === 0 || this.#listenerSnapshotInFlight) return;
    const transport = this.#transport;
    if (transport === null) return;
    this.#listenerSnapshotInFlight = true;
    try {
      // Do not pause the PTY; output written while this resolves is simply
      // covered by the next periodic snapshot.
      await this.#mirror?.flush();
      if (this.#closing || this.#listeners.size === 0) return;
      if ((this.#client?.bufferedAmount ?? 0) > LISTENER_RELAY_BUFFER_BUDGET) {
        this.#logger.debug("listener snapshots skipped: relay buffer is high");
        return;
      }
      const payload = Buffer.from(this.#serializeSnapshot(""), "utf8");
      const seq = Math.max(0, this.#lastAssignedSeq);
      let sent = 0;
      for (const target of this.#listeners) {
        // Re-check per listener: all frames share the host's socket, and the
        // next periodic tick will catch any listener skipped here.
        if ((this.#client?.bufferedAmount ?? 0) > LISTENER_RELAY_BUFFER_BUDGET) {
          break;
        }
        try {
          transport.send(encodeFrame({ type: "snapshot_to", targetId: target, seq, payload }));
          sent += 1;
        } catch (error) {
          // A single bad listener must not end the session or stop the timer.
          this.#logger.warn(`failed to send listener snapshot to ${target}: ${formatError(error)}`);
        }
      }
      this.#logger.debug(
        `listener snapshots sent (listeners=${sent}, bytes=${payload.byteLength}, seq=${seq})`,
      );
    } finally {
      this.#listenerSnapshotInFlight = false;
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
    this.#fragmentationViewers.clear();
    this.#tunnelViewers.clear();
    this.#nonViewportViewers.clear();
    for (const timer of this.#p2pRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.#p2pRetryTimers.clear();
    this.#p2pRetryUsed.clear();
    this.#p2pRetriesInFlight = 0;
    if (this.#snapshotTimer !== null) {
      clearTimeout(this.#snapshotTimer);
      this.#snapshotTimer = null;
    }
    this.#stopListenerTimer();
    this.#listeners.clear();
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
    this.#iceManager.dispose();
    this.#transport = null;
    this.#logger.setSink(null);
    this.#viewport?.dispose();
    this.#viewport = null;
    this.#flushDeferredLogs();
    this.#pty?.kill();
    this.#pty = null;
    this.#mirror?.dispose();
    this.#mirror = null;
  }
}
