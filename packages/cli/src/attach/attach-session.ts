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
  type ClientInfo,
  decodeFrame,
  encodeFrame,
  type IceTransportPolicy,
  isTerminalSizeWithinLimits,
  type KnownControlMessage,
  PROTOCOL_VERSION,
  type TransportMode,
  toU64String,
  type WelcomeMessage,
} from "@limccn/tokimeki-protocol";
import type { CliMode } from "../cli-mode.js";
import { buildClientDescriptor } from "../client-info.js";
import type { AttachConfig } from "../config.js";
import {
  type CliEventWriter,
  eventConnectionState,
  eventTransport,
  mapRelayErrorCode,
} from "../events.js";
import { formatError, type Logger } from "../logger.js";
import { TerminalMirror } from "../terminal/mirror.js";
import { ModeTracker } from "../terminal/mode-tracker.js";
import {
  CLEAR_SCREEN,
  ENTER_ALTERNATE_SCREEN,
  terminalRestoreSequence,
} from "../terminal/restore.js";
import {
  LocalViewport,
  type MenuAction,
  type MenuModel,
  type ViewportRelayState,
  type ViewportStatus,
  type ViewportTransport,
} from "../terminal/viewport/index.js";
import { buildCapabilities, hostAnswersTerminalQueries } from "../transport/capabilities.js";
import { buildNodeRtcConfig, resolveIceTransportPolicy } from "../transport/ice.js";
import { IceConfigManager } from "../transport/ice-config.js";
import { P2PPeer } from "../transport/p2p-peer.js";
import { RelayClient, type RelayClientOptions } from "../transport/relay-client.js";
import { RelayTransport } from "../transport/relay-transport.js";
import type { RelayConnectionState, RelayFatalError } from "../transport/relay-types.js";
import { RouteSelector } from "../transport/route-selector.js";
import {
  parseTunnelOffer,
  type TunnelFecMode,
  type TunnelOfferParams,
  tunnelOfferCompatible,
} from "../transport/tunnel/capability.js";
import { TunnelTransport } from "../transport/tunnel/tunnel-transport.js";
import type { Transport } from "../transport/types.js";
import { isStaleSnapshot, SeqReducer } from "./seq-reducer.js";

export interface AttachSessionDeps {
  readonly logger: Logger;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly platform?: NodeJS.Platform;
  /** Test seam: replace the WebSocket relay client. */
  readonly createClient?: (options: RelayClientOptions) => RelayClient;
  /** Test seam: replace relay transport selection. */
  readonly selectTransport?: (client: RelayClient) => Promise<Transport>;
  /** Daemon mode emits structured events; interactive mode stays human-only. */
  readonly mode?: CliMode;
  readonly events?: CliEventWriter;
  /** Invoked once the first welcome completes (the attach wizard uses this). */
  readonly onWelcome?: () => void;
}

const RESYNC_THROTTLE_MS = 500;
/** Pre-switch DC output buffer bound; overflow forces a fresh snapshot. */
const DC_BUFFER_LIMIT_BYTES = 4_194_304;

interface BufferedOutput {
  readonly seq: number;
  readonly payload: Uint8Array;
}

type SizedWriteStream = NodeJS.WriteStream & { columns?: number; rows?: number; fd?: number };

export function maskViewerToken(value: string): string {
  if (value.length <= 8) return "*".repeat(Math.max(4, value.length));
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

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
  readonly #stderr: NodeJS.WriteStream;
  readonly #platform: NodeJS.Platform;
  readonly #clientId = randomUUID();
  readonly #reducer = new SeqReducer();
  /** v1.1 read-only mode: snapshots only, no input/resize/ACK/resync/P2P. */
  readonly #listener: boolean;
  readonly #createClient: ((options: RelayClientOptions) => RelayClient) | null;
  readonly #selectTransport: ((client: RelayClient) => Promise<Transport>) | null;
  readonly #events: CliEventWriter | null;
  readonly #onWelcome: (() => void) | undefined;
  #readyEmitted = false;

  #client: RelayClient | null = null;
  #transport: Transport | null = null;
  #mirror: TerminalMirror | null = null;
  #viewport: LocalViewport | null = null;
  #fixedSize: { cols: number; rows: number } | null = null;
  #relayState: ViewportRelayState = "connecting";
  #transportMode: ViewportTransport = "relay";
  /** Logs captured by the viewport sink and replayed after restore. */
  readonly #deferredLogs: string[] = [];
  readonly #iceManager: IceConfigManager;
  #iceTransportPolicy: IceTransportPolicy;
  #peer: P2PPeer | null = null;
  #tunnel: TunnelTransport | null = null;
  #tunnelFec: TunnelFecMode | null = null;
  #hostOnline: boolean | null = null;
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
    this.#listener = config.role === "listener";
    this.#createClient = deps.createClient ?? null;
    this.#selectTransport = deps.selectTransport ?? null;
    this.#events = deps.mode === "daemon" ? (deps.events ?? null) : null;
    this.#onWelcome = deps.onWelcome;
    this.#iceTransportPolicy = config.iceTransportPolicy;
    this.#logger = deps.logger;
    this.#stdin = deps.stdin ?? process.stdin;
    this.#stdout = deps.stdout ?? process.stdout;
    this.#stderr = deps.stderr ?? process.stderr;
    this.#platform = deps.platform ?? process.platform;
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

    const wireSize = this.#sizeForWire();
    const clientOptions: RelayClientOptions = {
      url: this.#config.websocketUrl,
      headers: {
        "X-Tokimeki-Session": this.#config.sessionToken,
        ...(this.#config.passcode === null ? {} : { "X-Tokimeki-Passcode": this.#config.passcode }),
        ...(this.#listener ? { "X-Tokimeki-Listener": "1" } : {}),
      },
      role: this.#config.role,
      session: this.#config.session,
      clientId: this.#clientId,
      // Only an interactive local terminal may drive PTY sizing; non-TTY
      // attach and zero-dimension TTYs must not resize the shared PTY.
      ...(wireSize === null ? {} : { cols: wireSize.cols, rows: wireSize.rows }),
      heartbeatSeconds: this.#config.heartbeatSeconds,
      client: buildClientDescriptor({ platform: this.#platform }),
      capabilities: buildCapabilities({
        p2p: this.#config.p2p === "auto" && !this.#listener,
        listener: this.#listener,
        sessionSecurity: this.#config.passcode !== null,
        ...(this.#config.tunnel === "auto" && !this.#listener
          ? { tunnelKeyMode: this.#config.tunnelKeyMode }
          : {}),
        ...(this.#config.windowMode === "off"
          ? {}
          : {
              display: {
                modes: ["viewport"],
                logPanel: true,
              },
            }),
      }),
      logger: this.#logger,
    };
    const client =
      this.#createClient === null
        ? new RelayClient(clientOptions)
        : this.#createClient(clientOptions);
    this.#client = client;
    client.onWelcome((welcome) => this.#handleWelcome(welcome));
    client.onMessage((message) => this.#handleControl(message));
    client.onState((state) => this.#handleState(state));
    client.onFatal((error) => this.#handleFatal(error));

    const selectTransport =
      this.#selectTransport ??
      ((relayClient: RelayClient) =>
        new RouteSelector({
          // Listeners never attempt P2P; their base transport is the relay.
          p2p: this.#listener ? "off" : this.#config.p2p,
          logger: this.#logger,
          createRelayTransport: () => new RelayTransport(relayClient),
        }).select());
    void selectTransport(client)
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

  /** Dimensions safe to send over the wire; null when this client must not resize. */
  #sizeForWire(): { cols: number; rows: number } | null {
    if (!this.#interactive || this.#listener) return null;
    const sized = this.#stdout as SizedWriteStream;
    if (
      typeof sized.columns !== "number" ||
      typeof sized.rows !== "number" ||
      sized.columns < 1 ||
      sized.rows < 1
    ) {
      return null;
    }
    return { cols: sized.columns, rows: sized.rows };
  }

  #installLocalTerminal(): void {
    this.#stdinHandler = (chunk) => {
      if (!this.#screenActive) return;
      const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      if (data.byteLength === 0) return;
      if (this.#listener) {
        // A listener is read-only. Ctrl-C (0x03) only stops this local
        // listener; every other keystroke is ignored and never reaches the PTY.
        if (data.includes(0x03)) {
          this.#finish(0, "listener stopped");
        }
        return;
      }
      if (this.#viewport !== null) {
        this.#viewport.handleInput(data);
        return;
      }
      this.#sendInput(data);
    };
    try {
      this.#stdin.resume();
      this.#stdin.on("data", this.#stdinHandler);
    } catch {
      // stdin may not be readable
    }

    this.#resizeHandler = () => {
      this.#viewport?.resizeLocal(this.#localSize());
      this.#sendResize();
    };
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
      if (this.#viewport !== null) {
        this.#viewport.restoreSync();
        this.#flushDeferredLogs();
        return;
      }
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

  #sendInput(data: Uint8Array): void {
    if (this.#closing || this.#listener || data.byteLength === 0) return;
    try {
      // Control-plane frames stay on the relay; terminal input prefers the
      // direct path once the host has announced it ready. Tunnel input is
      // split into records by the endpoint before encoding.
      if (this.#p2pReady && this.#peer !== null) {
        if (this.#tunnel !== null) {
          if (this.#tunnel.sendTerminalInput(data)) return;
          this.#handleP2PFailure("tunnel input send failed");
        } else {
          const frame = encodeFrame({ type: "input", payload: data });
          if (this.#peer.send(frame)) return;
        }
      }
      this.#transport?.send(encodeFrame({ type: "input", payload: data }));
    } catch (error) {
      this.#logger.debug(`failed to encode input: ${formatError(error)}`);
    }
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
    this.#hostOnline = welcome.hostOnline;
    if (!welcome.hostOnline) {
      this.#logger.warn("host is offline; waiting for it to come online");
    }
    this.#reducer.reset();
    this.#logger.info(`attached to session ${this.#config.session}`);
    this.#relayState = "ready";
    this.#prepareViewport(welcome.clients);
    this.#enterScreen();
    // Tell the host our terminal size even if the relay did not synthesize a
    // resize from hello. The host ignores no-op resizes.
    this.#sendResize();
    this.#onWelcome?.();
    if (!this.#readyEmitted) {
      this.#readyEmitted = true;
      this.#events?.ready({
        command: "attach",
        role: this.#listener ? "listener" : "viewer",
        relay: this.#config.relayUrl,
        session: this.#config.session,
        ...(this.#listener ? { listener: true } : {}),
        transport: eventTransport(this.#transportMode),
      });
    }
  }

  #prepareViewport(clients: readonly ClientInfo[]): boolean {
    if (!this.#interactive || this.#config.windowMode === "off") {
      this.#disposeViewport();
      return false;
    }

    const host = clients.find((client) => client.role === "host");
    const display = host?.capabilities?.display;
    const fixed = display?.fixed;
    if (
      host === undefined ||
      fixed === undefined ||
      display?.modes?.includes("fixed-grid") !== true ||
      !isTerminalSizeWithinLimits(fixed.cols, fixed.rows)
    ) {
      if (this.#viewport === null) {
        this.#logger.debug("fixed window metadata unavailable; using legacy rendering");
      }
      return false;
    }
    if (
      this.#viewport !== null &&
      this.#fixedSize?.cols === fixed.cols &&
      this.#fixedSize.rows === fixed.rows
    ) {
      return false;
    }

    this.#disposeViewport();
    const tracker = new ModeTracker();
    const mirror = new TerminalMirror({
      cols: fixed.cols,
      rows: fixed.rows,
      scrollback: 0,
      // New hosts answer terminal queries themselves. Legacy hosts expect the
      // viewer terminal (now the mirror) to answer as INPUT.
      ...(this.#listener || hostAnswersTerminalQueries(host.capabilities)
        ? {}
        : { onReply: (data: string) => this.#sendInput(Buffer.from(data, "utf8")) }),
    });
    this.#mirror = mirror;
    this.#fixedSize = { cols: fixed.cols, rows: fixed.rows };
    this.#viewport = new LocalViewport({
      mirror,
      tracker,
      stdout: this.#stdout,
      logViewRows: this.#config.logLevel === "debug" ? this.#config.logViewRows : 0,
      status: this.#statusModel(),
      onInput: (data) => this.#sendInput(data),
      ...(this.#config.inviteKey === "off"
        ? {}
        : {
            menu: {
              key: this.#config.inviteKey,
              role: this.#listener ? "listener" : "viewer",
              getModel: ({ revealToken }) => this.#menuModel(revealToken),
              onAction: (action) => this.#handleMenuAction(action),
              copyText: JSON.stringify({
                version: 1,
                relayUrl: this.#config.relayUrl,
                session: this.#config.session,
                sessionToken: this.#config.sessionToken,
              }),
            },
          }),
    });
    return true;
  }

  #disposeViewport(): void {
    this.#viewport?.dispose();
    this.#mirror?.dispose();
    this.#viewport = null;
    this.#mirror = null;
    this.#fixedSize = null;
  }

  #enterScreen(): void {
    this.#screenActive = true;
    if (!this.#interactive) return;
    if (this.#viewport !== null) {
      this.#viewport.start();
      this.#logger.setSink((line) => {
        this.#viewport?.appendLog(line);
        if (this.#config.logLevel !== "debug" || this.#config.logViewRows === 0) {
          if (this.#deferredLogs.length >= 256) this.#deferredLogs.shift();
          this.#deferredLogs.push(line);
        }
      });
      this.#logger.setMuted(false);
      this.#updateViewportStatus();
    } else {
      this.#writeRaw(ENTER_ALTERNATE_SCREEN);
      this.#logger.setMuted(true);
    }
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
    if (this.#viewport !== null) {
      this.#logger.setSink(null);
      this.#disposeViewport();
      this.#flushDeferredLogs();
    } else {
      this.#writeRaw(terminalRestoreSequence());
    }
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
    if (this.#closing || this.#listener) return;
    const size = this.#sizeForWire();
    if (size === null) return;
    this.#client?.sendControl({
      v: PROTOCOL_VERSION,
      type: "resize",
      clientId: this.#clientId,
      cols: size.cols,
      rows: size.rows,
    });
  }

  #handleState(state: RelayConnectionState): void {
    this.#relayState = state;
    this.#updateViewportStatus();
    this.#events?.status({
      connection: {
        state: eventConnectionState(state),
        transport: eventTransport(this.#transportMode),
      },
      configured: true,
      relay: this.#config.relayUrl,
      session: this.#config.session,
    });
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

  #statusModel(): ViewportStatus {
    return {
      role: this.#listener ? "listener" : "viewer",
      session: this.#config.session,
      relayState: this.#relayState,
      viewers: 0,
      transport: this.#transportMode,
    };
  }

  #menuModel(revealToken: boolean): MenuModel {
    const token = revealToken
      ? this.#config.sessionToken
      : maskViewerToken(this.#config.sessionToken);
    const host = this.#hostOnline === null ? "unknown" : this.#hostOnline ? "online" : "offline";
    return {
      title: "TOKIMEKI CONNECTION",
      lines: [
        `role: ${this.#listener ? "listener (read-only)" : "viewer"}`,
        `relay: ${this.#config.relayUrl}`,
        `session: ${this.#config.session}`,
        `session token: ${token}`,
        `connection: ${this.#relayState}   transport: ${this.#transportMode}`,
        `host: ${host}`,
      ],
      items: [
        { id: "status", label: "Refresh status" },
        { id: "show-token", label: "Show/hide session token" },
        { id: "copy-config", label: "Copy viewer config (OSC 52)" },
        { id: "reconnect", label: "Reconnect / request a fresh snapshot" },
        { id: "disconnect", label: "Disconnect this viewer/listener" },
        ...(this.#config.logLevel === "debug" && this.#config.logViewRows > 0
          ? [{ id: "open-logs", label: "Open log view (F11)" }]
          : []),
      ],
    };
  }

  #handleMenuAction(action: MenuAction): void {
    if (action.type === "reconnect") {
      this.#logger.info("reconnect requested from the local menu");
      this.#requestResync();
      return;
    }
    if (action.type === "disconnect") {
      this.#logger.info("disconnected from the local menu");
      this.#finish(0, "disconnected by user");
    }
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

  #updateViewportStatus(): void {
    this.#viewport?.setStatus(this.#statusModel());
  }

  #handleFatal(error: RelayFatalError): void {
    if (error.code === "host_exited") {
      this.#finish(0, "host exited");
      return;
    }
    const code = error.code === "unauthorized" ? 2 : error.code === "session_full" ? 3 : 1;
    this.#events?.error({
      code: mapRelayErrorCode(error.code),
      message: error.message,
      retryable: false,
      exitCode: code,
    });
    this.#finish(code, `${error.code}: ${error.message}`);
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
        // Listeners never participate in P2P signaling.
        if (this.#listener) return;
        if (message.kind === "offer") {
          // A new offer means the host started a new P2P attempt (initial
          // switch or the one-shot retry). Silently drop any old peer so a
          // lost relay-failure control message cannot strand the viewer.
          if (this.#peer !== null) {
            this.#disposeP2P("host restarted p2p negotiation");
          }
          const payload = asRecord(message.payload);
          const rawTunnel = payload?.tunnel;
          let tunnelOffer: TunnelOfferParams | null = null;
          if (rawTunnel !== undefined) {
            const offer = parseTunnelOffer(rawTunnel);
            if (
              offer === null ||
              this.#config.tunnel !== "auto" ||
              !tunnelOfferCompatible(offer, this.#config.tunnelKeyMode)
            ) {
              // An unreliable DataChannel must never carry v1 frames. Refuse
              // the attempt instead of silently downgrading.
              this.#refuseTunnel(
                offer === null ? "unsupported offer parameters" : "tunnel key mode mismatch",
              );
              return;
            }
            tunnelOffer = offer;
          }
          this.#startViewerPeer(message.from, tunnelOffer);
        }
        this.#peer?.handleSignal({ kind: message.kind, payload: message.payload });
        return;
      }
      case "transport": {
        // Listener transport is fixed to the relay; ignore any update.
        if (this.#listener) return;
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
      case "host": {
        // A restarted host process resets its output sequence to 0. A listener
        // that stayed connected across that restart would otherwise reject
        // every new snapshot as stale (`seq < lastSeq`) and freeze on the old
        // screen, so rebase on the next snapshot when a host comes online.
        if (this.#listener && message.online) {
          this.#logger.debug("host online; resetting listener snapshot sequence");
          this.#reducer.reset();
        }
        return;
      }
      case "presence": {
        // A viewer may attach before the host; presence is how the relay
        // announces the host (and its display.fixed metadata) later.
        const created = this.#prepareViewport(message.clients);
        if (created && this.#screenActive) {
          this.#enterScreen();
        }
        return;
      }
      default:
        return;
    }
  }

  #startViewerPeer(hostClientId: string, tunnelOffer: TunnelOfferParams | null): void {
    if (this.#config.p2p === "off" || this.#closing || this.#listener) return;
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
      onOpen: (info) => this.#handleP2POpen(info.mode, info.detail, info.lan),
      onFailed: (reason) => this.#handleP2PFailure(reason),
      onClosed: (reason) => this.#handleP2PFailure(reason),
    });
    this.#peer = peer;
    if (tunnelOffer !== null) {
      // The host decides parity per link; this endpoint only sends parity when
      // its local policy also allows it. Receiving peer parity always works.
      const fec: TunnelFecMode =
        tunnelOffer.fec === "xor" && this.#config.tunnelFec === "xor" ? "xor" : "none";
      try {
        this.#tunnel = new TunnelTransport({
          role: "viewer",
          sessionId: this.#config.session,
          sessionToken: this.#config.sessionToken,
          keyMode: this.#config.tunnelKeyMode,
          secret: this.#config.tunnelSecret,
          fec,
          logger: this.#logger,
          sendFrame: (bytes) => peer.send(bytes),
          onFrame: (bytes) => this.#handleDcFrame(bytes, true),
          onFailure: (reason) => this.#handleTunnelFailure(reason),
        });
        this.#tunnelFec = fec;
        this.#logger.info(`tunnel negotiated (keyMode=${this.#config.tunnelKeyMode}, fec=${fec})`);
      } catch (error) {
        this.#logger.warn(`tunnel setup failed: ${formatError(error)}`);
        this.#disposeP2P("tunnel setup failed");
        this.#refuseTunnel("tunnel setup failed");
        return;
      }
    }
    this.#logger.debug(`p2p answer path started for host ${hostClientId}`);
  }

  /** Refuse an unreliable tunnel attempt and stay on the relay path. */
  #refuseTunnel(reason: string): void {
    this.#logger.warn(`tunnel offer refused (${reason}); staying on relay`);
    try {
      this.#client?.sendControl({
        v: PROTOCOL_VERSION,
        type: "transport",
        clientId: this.#clientId,
        mode: "relay",
        state: "failed",
        reason: reason.slice(0, 512),
      });
    } catch {
      // best effort
    }
  }

  #handleTunnelFailure(reason: string): void {
    const stats = this.#tunnel?.stats;
    if (stats !== undefined) {
      this.#logger.debug(
        `tunnel stats: sent=${stats.sentRecords} received=${stats.receivedRecords} ` +
          `retransmits=${stats.retransmits} decryptFailures=${stats.decryptFailures} ` +
          `fecGroups=${stats.fecGroupsSent} fecRecovered=${stats.fecRecovered} ` +
          `fecDropped=${stats.fecParityDropped}`,
      );
    }
    this.#handleP2PFailure(`tunnel: ${reason}`);
  }

  #handleP2POpen(mode: TransportMode, detail: string, lan: boolean): void {
    this.#transportMode = mode;
    this.#updateViewportStatus();
    this.#logger.debug(
      `p2p data channel open (${mode}, ${detail}, lan=${lan ? "yes" : "no"}); ` +
        "waiting for host snapshot+switch",
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
      this.#logger.info(
        this.#tunnel === null
          ? `p2p transport ready: ${mode}`
          : `p2p tunnel ready: ${mode} (fec=${this.#tunnelFec ?? "none"})`,
      );
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
    this.#tunnel?.dispose();
    this.#tunnel = null;
    this.#tunnelFec = null;
    this.#p2pReady = false;
    this.#p2pSnapshotSeen = false;
    this.#p2pBufferOverflow = false;
    this.#dcBuffer = [];
    this.#dcBufferBytes = 0;
    this.#transportMode = "relay";
    this.#updateViewportStatus();
    peer?.close(reason);
  }

  #handleDcFrame(bytes: Uint8Array, viaTunnel = false): void {
    let frame: ReturnType<typeof decodeFrame>;
    try {
      frame = decodeFrame(bytes);
    } catch (error) {
      this.#logger.debug(`invalid frame over p2p: ${formatError(error)}`);
      return;
    }
    if (frame.type === "tunnel") {
      if (viaTunnel) {
        this.#logger.debug("ignoring nested tunnel frame");
        return;
      }
      if (this.#tunnel === null) {
        this.#logger.debug("ignoring tunnel frame without an active tunnel");
        return;
      }
      this.#tunnel.receive(frame.payload);
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
      this.#writeTerminal(payload);
      if (viaRelay) this.#sendAck(seq);
    } else if (decision === "gap") {
      this.#requestResync();
    }
  }

  #writeTerminal(data: Uint8Array): void {
    if (this.#viewport !== null) {
      this.#viewport.write(data);
      return;
    }
    this.#writeRaw(data);
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
        // Snapshot-only: a listener must never apply incremental output even
        // if a relay bug or a stale server sends it.
        if (this.#listener) return;
        this.#applyOutput(frame.seq, frame.payload, viaRelay);
        return;
      case "tunnel":
      case "tunnel_to":
        // Raw TUNNEL records are handled by the P2P tunnel endpoint; the relay
        // never forwards them, so anything here is stale or out of contract.
        this.#logger.debug("ignoring unhandled tunnel frame");
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
    // Listeners are outside the relay's ACK/backpressure accounting. A
    // snapshot ACK from a listener would be rejected and must never be sent.
    if (this.#listener) return;
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
      if (this.#viewport !== null) {
        this.#viewport.resetAndWriteSnapshot(payload);
      } else {
        this.#writeRaw(CLEAR_SCREEN);
        if (payload.byteLength > 0) {
          this.#writeRaw(payload);
        }
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
    // Listeners recover from the host's next periodic snapshot; they never
    // send resync requests.
    if (this.#listener) return;
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
