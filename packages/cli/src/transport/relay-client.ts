/**
 * WebSocket relay client shared by host and attach sessions.
 *
 * Responsibilities:
 * - perform the hello/welcome handshake,
 * - keep the socket alive with application-level ping/pong,
 * - reconnect with exponential backoff and jitter,
 * - turn relay errors and close codes into structured fatal conditions.
 *
 * Tokens only ever travel in the handshake headers; they are never placed in
 * the URL and never logged.
 */

import {
  type Capabilities,
  CLOSE_CODES,
  type ClientDescriptor,
  decodeFrame,
  type ErrorMessage,
  encodeControlMessage,
  isAgentMessage,
  type KnownControlMessage,
  PROTOCOL_VERSION,
  ProtocolMessageError,
  parseControlMessage,
  type WelcomeMessage,
} from "@limccn/tokimeki-protocol";
import WebSocket, { type RawData } from "ws";

import type { Logger } from "../logger.js";
import type { RelayConnectionState, RelayFatalError } from "./relay-types.js";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface RelayClientOptions {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly role: "host" | "viewer" | "listener";
  readonly session: string;
  readonly clientId: string;
  readonly cols?: number;
  readonly rows?: number;
  readonly heartbeatSeconds: number;
  /** User-Agent-like identity sent in `hello.client`. */
  readonly client?: ClientDescriptor;
  readonly capabilities: Capabilities;
  readonly logger: Logger;
}

/**
 * Headers for the relay upgrade request.
 *
 * A listener is identified by an internal header rather than the URL or
 * `hello`; the Worker fixes the role before the DO sees the connection.
 */
export function relayHandshakeHeaders(
  role: RelayClientOptions["role"],
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  return role === "listener" ? { ...headers, "X-Tokimeki-Listener": "1" } : { ...headers };
}

type WelcomeHandler = (welcome: WelcomeMessage) => void;
type MessageHandler = (message: KnownControlMessage) => void;
type FrameHandler = (bytes: Uint8Array) => void;
type StateHandler = (state: RelayConnectionState) => void;
type FatalHandler = (error: RelayFatalError) => void;

function toBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  return new Uint8Array(data);
}

export class RelayClient {
  readonly #options: RelayClientOptions;
  readonly #logger: Logger;
  readonly #welcomeHandlers = new Set<WelcomeHandler>();
  readonly #messageHandlers = new Set<MessageHandler>();
  readonly #frameHandlers = new Set<FrameHandler>();
  readonly #stateHandlers = new Set<StateHandler>();
  readonly #fatalHandlers = new Set<FatalHandler>();

  #socket: WebSocket | null = null;
  #state: RelayConnectionState = "closed";
  #started = false;
  #stopped = false;
  #ready = false;
  #fatal = false;
  #attempt = 0;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #handshakeTimer: NodeJS.Timeout | null = null;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #lastInboundAt = 0;
  #lastError: ErrorMessage | null = null;

  constructor(options: RelayClientOptions) {
    this.#options = options;
    this.#logger = options.logger;
  }

  get state(): RelayConnectionState {
    return this.#state;
  }

  get isReady(): boolean {
    return this.#ready;
  }

  get bufferedAmount(): number {
    return this.#socket?.bufferedAmount ?? 0;
  }

  onWelcome(handler: WelcomeHandler): () => void {
    this.#welcomeHandlers.add(handler);
    return () => this.#welcomeHandlers.delete(handler);
  }

  onMessage(handler: MessageHandler): () => void {
    this.#messageHandlers.add(handler);
    return () => this.#messageHandlers.delete(handler);
  }

  onFrame(handler: FrameHandler): () => void {
    this.#frameHandlers.add(handler);
    return () => this.#frameHandlers.delete(handler);
  }

  onState(handler: StateHandler): () => void {
    this.#stateHandlers.add(handler);
    return () => this.#stateHandlers.delete(handler);
  }

  onFatal(handler: FatalHandler): () => void {
    this.#fatalHandlers.add(handler);
    return () => this.#fatalHandlers.delete(handler);
  }

  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    this.#connect();
  }

  stop(code: number = CLOSE_CODES.normal, reason = "closed by client"): void {
    this.#stopped = true;
    this.#ready = false;
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(code, reason);
        } else {
          socket.terminate();
        }
      } catch {
        // best effort
      }
    }
    this.#setState("closed");
  }

  sendControl(message: unknown): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN || !this.#ready) {
      return;
    }
    let payload: string;
    try {
      payload = encodeControlMessage(message);
    } catch (error) {
      this.#logger.warn(`dropping invalid control message: ${String(error)}`);
      return;
    }
    try {
      socket.send(payload);
    } catch (error) {
      this.#logger.debug(`control send failed: ${String(error)}`);
    }
  }

  sendFrame(bytes: Uint8Array): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN || !this.#ready) {
      return;
    }
    try {
      socket.send(bytes, { binary: true });
    } catch (error) {
      this.#logger.debug(`frame send failed: ${String(error)}`);
    }
  }

  /** Pause reading from the socket (local stdout backpressure). */
  pauseReading(): void {
    this.#socket?.pause();
  }

  resumeReading(): void {
    this.#socket?.resume();
  }

  #setState(state: RelayConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const handler of this.#stateHandlers) handler(state);
  }

  #clearTimers(): void {
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#handshakeTimer !== null) {
      clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = null;
    }
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  #connect(): void {
    if (this.#stopped) return;
    this.#ready = false;
    this.#lastError = null;
    this.#setState("connecting");
    this.#logger.debug(
      `connecting to relay (${this.#options.role} session ${this.#options.session})`,
    );

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.#options.url, {
        headers: relayHandshakeHeaders(this.#options.role, this.#options.headers),
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        perMessageDeflate: false,
        followRedirects: false,
      });
    } catch (error) {
      this.#logger.warn(`relay connection failed: ${String(error)}`);
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.on("open", () => {
      if (this.#socket !== socket) return;
      this.#sendHello(socket);
      this.#handshakeTimer = setTimeout(() => {
        if (this.#socket === socket && !this.#ready) {
          this.#logger.warn("relay handshake timed out");
          this.#terminateSocket(socket);
        }
      }, HANDSHAKE_TIMEOUT_MS);
    });

    socket.on("unexpected-response", (_request, response) => {
      if (this.#socket !== socket) return;
      const status = response.statusCode ?? 0;
      if (status === 401 || status === 403) {
        response.resume();
        this.#handleFatal("unauthorized", `relay rejected the connection (HTTP ${status})`);
        return;
      }
      this.#logger.warn(`relay rejected the WebSocket upgrade (HTTP ${status})`);
      response.resume();
      this.#socket = null;
      this.#scheduleReconnect();
    });

    socket.on("message", (data, isBinary) => {
      if (this.#socket !== socket) return;
      this.#lastInboundAt = Date.now();
      if (isBinary) {
        this.#handleBinary(toBytes(data));
      } else {
        this.#handleText(Buffer.from(toBytes(data)).toString("utf8"));
      }
    });

    socket.on("error", (error) => {
      if (this.#socket !== socket) return;
      this.#logger.debug(`relay socket error: ${error.message}`);
    });

    socket.on("close", (code, reasonBuffer) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#ready = false;
      this.#clearTimers();
      const reason = reasonBuffer.toString("utf8");
      if (this.#stopped || this.#fatal) {
        this.#setState("closed");
        return;
      }
      const closeError = this.#classifyClose(code);
      if (closeError !== null) {
        this.#handleFatal(closeError.code, closeError.message);
        return;
      }
      this.#logger.warn(
        `relay disconnected (code ${code}${reason === "" ? "" : `: ${reason}`}); reconnecting`,
      );
      this.#setState("reconnecting");
      this.#scheduleReconnect();
    });
  }

  #sendHello(socket: WebSocket): void {
    const options = this.#options;
    const hello = {
      v: PROTOCOL_VERSION,
      type: "hello" as const,
      role: options.role,
      session: options.session,
      clientId: options.clientId,
      protocolVersion: PROTOCOL_VERSION,
      ...(options.client === undefined ? {} : { client: options.client }),
      capabilities: options.capabilities,
      ...(options.cols === undefined ? {} : { cols: options.cols }),
      ...(options.rows === undefined ? {} : { rows: options.rows }),
    };
    try {
      socket.send(encodeControlMessage(hello));
    } catch (error) {
      this.#logger.warn(`failed to send hello: ${String(error)}`);
      this.#terminateSocket(socket);
    }
  }

  #handleText(text: string): void {
    let message: KnownControlMessage;
    try {
      const parsed = parseControlMessage(text);
      if (isAgentMessage(parsed)) {
        this.#logger.debug(`ignoring reserved agent message ${parsed.type}`);
        return;
      }
      message = parsed;
    } catch (error) {
      const detail = error instanceof ProtocolMessageError ? error.message : String(error);
      this.#logger.warn(`invalid control message from relay: ${detail}`);
      return;
    }

    if (message.type === "welcome") {
      if (message.session !== this.#options.session) {
        this.#handleFatal(
          "invalid_session",
          `relay welcomed session ${message.session} but ${this.#options.session} was requested`,
        );
        return;
      }
      if (this.#handshakeTimer !== null) {
        clearTimeout(this.#handshakeTimer);
        this.#handshakeTimer = null;
      }
      this.#ready = true;
      this.#attempt = 0;
      this.#lastInboundAt = Date.now();
      this.#lastError = null;
      this.#startHeartbeat();
      this.#logger.debug(
        `relay ready: session=${message.session} hostOnline=${String(message.hostOnline)} ` +
          `clients=${message.clients.length} iceProvider=${message.iceProvider}`,
      );
      this.#setState("ready");
      for (const handler of this.#welcomeHandlers) handler(message);
      return;
    }

    if (message.type === "ping") {
      this.sendControl({ v: PROTOCOL_VERSION, type: "pong", ts: message.ts });
      return;
    }
    if (message.type === "pong") {
      return;
    }
    if (message.type === "error") {
      this.#handleErrorMessage(message);
      for (const handler of this.#messageHandlers) handler(message);
      return;
    }

    for (const handler of this.#messageHandlers) handler(message);
  }

  #handleErrorMessage(message: ErrorMessage): void {
    this.#lastError = message;
    switch (message.code) {
      case "unauthorized":
      case "invalid_session":
      case "unsupported_version":
      case "session_full":
      case "invalid_client_id":
      case "duplicate_client_id":
        this.#handleFatal(message.code, message.message);
        return;
      case "host_offline":
      case "host_exited":
        if (this.#options.role !== "host") {
          this.#handleFatal(message.code, message.message);
          return;
        }
        this.#logger.warn(`relay error: ${message.code}: ${message.message}`);
        return;
      case "not_implemented":
        if (this.#options.role === "listener") {
          // A pre-v1.1 relay returns not_implemented for listener hello. Never
          // silently downgrade to a full viewer; fail with an actionable error.
          this.#handleFatal(
            "not_implemented",
            "relay does not support listener mode; upgrade the relay or run attach without --listen",
          );
          return;
        }
        this.#logger.warn(`relay does not implement this feature: ${message.message}`);
        return;
      default:
        this.#logger.warn(`relay error: ${message.code}: ${message.message}`);
    }
  }

  #handleBinary(bytes: Uint8Array): void {
    let frame: ReturnType<typeof decodeFrame>;
    try {
      frame = decodeFrame(bytes);
    } catch (error) {
      this.#logger.warn(`invalid binary frame from relay: ${String(error)}`);
      return;
    }
    for (const handler of this.#frameHandlers) handler(bytes);
    this.#logger.debug(`relay frame: ${frame.type}`);
  }

  #classifyClose(code: number): RelayFatalError | null {
    const last = this.#lastError;
    const messageText = last?.message ?? `relay closed the connection (code ${code})`;
    switch (code) {
      case CLOSE_CODES.unauthorized:
        return { code: "unauthorized", message: messageText };
      case CLOSE_CODES.sessionFull:
        return { code: "session_full", message: messageText };
      case CLOSE_CODES.hostExited:
        return { code: "host_exited", message: messageText };
      case CLOSE_CODES.notImplemented:
        return { code: "not_implemented", message: messageText };
      case CLOSE_CODES.slowConsumer:
        return { code: "slow_consumer", message: messageText };
      default:
        return null;
    }
  }

  #handleFatal(code: string, message: string): void {
    if (this.#fatal) return;
    this.#fatal = true;
    this.#stopped = true;
    this.#ready = false;
    this.#clearTimers();
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      try {
        socket.close();
      } catch {
        // best effort
      }
    }
    this.#logger.debug(`relay fatal: ${code}: ${message}`);
    this.#setState("failed");
    for (const handler of this.#fatalHandlers) handler({ code, message });
  }

  #terminateSocket(socket: WebSocket): void {
    if (this.#socket !== socket) return;
    this.#socket = null;
    this.#ready = false;
    this.#clearTimers();
    try {
      socket.terminate();
    } catch {
      // best effort
    }
    if (!this.#stopped && !this.#fatal) {
      this.#setState("reconnecting");
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#fatal || this.#reconnectTimer !== null) return;
    const exponent = Math.min(this.#attempt, 5);
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** exponent);
    const jitter = base * (0.8 + Math.random() * 0.4);
    const delay = Math.round(jitter);
    this.#attempt += 1;
    this.#logger.info(`reconnecting to relay in ${delay}ms`);
    this.#setState("reconnecting");
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  #startHeartbeat(): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    const seconds = this.#options.heartbeatSeconds;
    if (seconds <= 0) return;
    const intervalMs = seconds * 1000;
    this.#lastInboundAt = Date.now();
    this.#heartbeatTimer = setInterval(() => {
      const socket = this.#socket;
      if (socket === null || !this.#ready) return;
      const silence = Date.now() - this.#lastInboundAt;
      if (silence > intervalMs * 2.5) {
        this.#logger.warn(`relay heartbeat missed for ${Math.round(silence / 1000)}s`);
        this.#terminateSocket(socket);
        return;
      }
      this.sendControl({ v: PROTOCOL_VERSION, type: "ping", ts: Date.now() });
    }, intervalMs);
  }
}
