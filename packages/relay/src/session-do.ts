import { DurableObject } from "cloudflare:workers";
import {
  type AgentMessage,
  type AnyRole,
  type Capabilities,
  CLOSE_CODES,
  type ClientDescriptor,
  type ClientInfo,
  type ControlMessage,
  createNotImplementedErrorMessage,
  decodeFrame,
  type ErrorCode,
  encodeControlMessage,
  type HelloMessage,
  type IceProvider,
  isActiveRole,
  isAgentMessage,
  isTerminalSizeWithinLimits,
  isValidSessionId,
  type KnownControlMessage,
  MAX_ERROR_MESSAGE_LENGTH,
  PROTOCOL_VERSION,
  ProtocolFrameError,
  type Role,
  safeParseControlMessage,
  type TransportMode,
  type TransportState,
  u64StringToNumber,
} from "@limccn/tokimeki-protocol";

import {
  base64UrlToBytes,
  bytesToBase64Url,
  constantTimeEqual,
  constantTimeEqualHex,
  sha256Hex,
} from "./crypto-utils.js";
import {
  iceTransportPolicy,
  maxClientsPerSession,
  maxListenersPerSession,
  type RelayEnv,
  sessionIdleTtlSeconds,
  sessionMaxBytes,
  sessionMaxMessagesPerSecond,
  sessionMaxTtlSeconds,
  sessionTtlSeconds,
} from "./env.js";
import { createLogger, type Logger } from "./logging.js";
import { deriveNamespaceFromSessionId, isNamespaceSessionId } from "./namespace-tokens.js";
import {
  clearHostExit,
  clearPasscodeFailures,
  ensureRelaySchema,
  insertSessionMetadata,
  loadHostExit,
  loadSessionMetadata,
  loadSessionPasscode,
  nextAgentLeaseExpiry,
  recordPasscodeFailure,
  saveHostExit,
  saveSessionPasscode,
  setAbsoluteDeadline,
  setHostOfflineDeadline,
  setRelayBytes,
  updateLastActivity,
} from "./storage.js";
import { issueIceConfig, stunOnlyIceConfig } from "./turn.js";

/** Anonymous sockets must send `hello` within this window. */
const HELLO_TIMEOUT_MS = 10_000;
const FLOW_HIGH_WATER_BYTES = 1 * 1024 * 1024;
const FLOW_LOW_WATER_BYTES = 256 * 1024;
const FLOW_HARD_LIMIT_BYTES = 8 * 1024 * 1024;
const RUNTIME_PAUSE_BUFFERED_BYTES = 4 * 1024 * 1024;
const ACK_RING_LIMIT = 256;
const RESIZE_THROTTLE_MS = 250;
const RESYNC_THROTTLE_MS = 500;
/**
 * A listener snapshot is dropped instead of queued when its socket already has
 * this much unflushed data. The next periodic snapshot supersedes it, so a slow
 * listener never grows relay memory or blocks the host/viewers.
 */
const LISTENER_SNAPSHOT_BUFFER_LIMIT = 1 * 1024 * 1024;
/**
 * Persist the session byte counter in this granularity. Hibernation between
 * flushes can lose at most this window, so the configured byte cap is an
 * approximate hard limit rather than an exact meter.
 */
const BYTES_FLUSH_THRESHOLD = 1 * 1024 * 1024;
/** Minimum interval between idle-TTL alarm reschedules triggered by activity. */
const IDLE_RESCHEDULE_INTERVAL_MS = 30_000;
/** Sliding window for `TOKIMEKI_SESSION_MAX_MESSAGES_PER_SECOND`. */
const MESSAGE_RATE_WINDOW_MS = 1_000;

const RELAY_CAPABILITIES = {
  protocolVersion: PROTOCOL_VERSION,
  transports: { modes: ["relay", "p2p-direct", "p2p-turn"] },
  snapshot: { formats: ["xterm-serialize"], maxBytes: 262_144 },
  listener: { modes: ["snapshot-only"] },
  sessionSecurity: { passcode: 1 },
} as const;

/** Viewer/listener passcode policy (v1.2-D). */
const MAX_PASSCODE_FAILURES = 5;
const PASSCODE_LOCKOUT_MS = 30_000;
const MIN_PASSCODE_INPUT_LENGTH = 6;
const MAX_PASSCODE_INPUT_LENGTH = 128;
const PASSCODE_DERIVED_BYTES = 32;

/** PBKDF2-SHA256 verifier hash, base64url encoded; `null` on bad salt/passcode. */
async function derivePasscodeHash(
  passcode: string,
  saltBase64Url: string,
  iterations: number,
): Promise<string | null> {
  const salt = base64UrlToBytes(saltBase64Url);
  if (salt === null) {
    return null;
  }
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(passcode),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
      key,
      PASSCODE_DERIVED_BYTES * 8,
    );
    return bytesToBase64Url(new Uint8Array(bits));
  } catch {
    return null;
  }
}

const SERVER_OWNED_CONTROL_TYPES = new Set<string>([
  "welcome",
  "ice",
  "peer-joined",
  "peer-left",
  "host",
  "presence",
  "pong",
  "error",
  "host-exited",
  "pause",
  "resume",
]);

interface PendingAttachment {
  readonly kind: "pending";
  readonly role: AnyRole;
  readonly connectedAt: number;
  readonly deadline: number;
  readonly tokenHash: string;
  /**
   * Internal namespace from the Worker's `x-tokimeki-namespace` header:
   * `"*"` for a root-master host, the namespace name for a namespace token or
   * a verified Session JWT, `null` for an opaque viewer/listener or a direct
   * DO connection.
   */
  readonly namespaceId: string | null;
  /**
   * Verified Session JWT session claim and role scope, injected only by the
   * Worker after `verifySessionJwt`. Their presence makes hello skip the
   * opaque host-token comparison, but never the session/namespace checks.
   */
  readonly sessionClaim: string | null;
  readonly sessionScope: "attach" | "listen" | null;
  /** Viewer/listener passcode from the Worker-trusted header (until hello). */
  readonly passcode: string | null;
}

interface PendingAck {
  readonly seq: number;
  readonly bytes: number;
}

interface ActiveAttachment {
  readonly kind: "active";
  readonly clientId: string;
  readonly role: Role;
  readonly connectedAt: number;
  lastSeenAt: number;
  transportMode: TransportMode;
  transportState: TransportState;
  paused: boolean;
  lastSentSeq: number;
  lastAckedSeq: number;
  unackedBytes: number;
  droppedBytes: number;
  pendingAcks: PendingAck[];
  /**
   * Set when a newer authenticated host connection replaces this socket for the
   * same client id. Superseded sockets are excluded from routing, presence, and
   * client-count calculations until their close event is observed.
   */
  superseded?: boolean;
  /** Last resize forwarded to the host; used for per-viewer throttling. */
  lastResizeAt?: number;
  /** Latest resize received during the throttle window. */
  pendingResize?: { cols: number; rows: number };
  /** Last resync forwarded to the host; used for per-viewer throttling. */
  lastResyncAt?: number;
  cols?: number;
  rows?: number;
  /** User-Agent-like identity echoed in welcome/presence (v0.1.2). */
  client?: ClientDescriptor;
  /** Rendering capabilities echoed in welcome/presence (v0.1.2). */
  capabilities?: Capabilities;
  /** Effective namespace recorded for hosts; diagnostic only. */
  namespaceId?: string | null;
}

type SocketAttachment = PendingAttachment | ActiveAttachment;

interface ActiveSocket {
  readonly ws: WebSocket;
  readonly att: ActiveAttachment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keep socket attachments small and bounded.
 *
 * `hello.capabilities` is a loose object and may contain arbitrary large
 * unknown fields. The relay only needs the User-Agent-like client descriptor
 * and the display capability for welcome/presence echo; storing anything else
 * risks the 2 KiB attachment limit and amplifies client data to every peer.
 */
function boundedClientDescriptor(
  client: ClientDescriptor | undefined,
): ClientDescriptor | undefined {
  if (client === undefined) return undefined;
  return {
    name: client.name.slice(0, 64),
    version: client.version.slice(0, 64),
    ...(client.kind === undefined ? {} : { kind: client.kind.slice(0, 32) }),
    ...(client.platform === undefined ? {} : { platform: client.platform.slice(0, 32) }),
    ...(client.runtime === undefined ? {} : { runtime: client.runtime.slice(0, 64) }),
  };
}

function boundedCapabilities(capabilities: Capabilities | undefined): Capabilities | undefined {
  const display = capabilities?.display;
  if (display === undefined) return undefined;
  return {
    display: {
      ...(display.modes === undefined
        ? {}
        : { modes: display.modes.slice(0, 16).map((mode) => mode.slice(0, 32)) }),
      ...(display.fixed === undefined
        ? {}
        : { fixed: { cols: display.fixed.cols, rows: display.fixed.rows } }),
      ...(display.logPanel === undefined ? {} : { logPanel: display.logPanel }),
      ...(display.terminalQueries === undefined
        ? {}
        : { terminalQueries: display.terminalQueries.slice(0, 32) }),
    },
  };
}

function readAttachment(ws: WebSocket): SocketAttachment | null {
  let raw: unknown;
  try {
    raw = ws.deserializeAttachment();
  } catch {
    return null;
  }
  if (!isRecord(raw)) {
    return null;
  }
  if (raw.kind === "pending") {
    if (
      typeof raw.role === "string" &&
      typeof raw.connectedAt === "number" &&
      typeof raw.deadline === "number" &&
      typeof raw.tokenHash === "string"
    ) {
      return {
        kind: "pending",
        role: raw.role as AnyRole,
        connectedAt: raw.connectedAt,
        deadline: raw.deadline,
        tokenHash: raw.tokenHash,
        // Missing on attachments persisted before namespace support.
        namespaceId: typeof raw.namespaceId === "string" ? raw.namespaceId : null,
        // Missing unless the Worker verified a Session JWT for this socket.
        sessionClaim: typeof raw.sessionClaim === "string" ? raw.sessionClaim : null,
        sessionScope:
          raw.sessionScope === "attach" || raw.sessionScope === "listen" ? raw.sessionScope : null,
        passcode: typeof raw.passcode === "string" ? raw.passcode : null,
      };
    }
    return null;
  }
  if (raw.kind === "active") {
    if (
      typeof raw.clientId === "string" &&
      typeof raw.role === "string" &&
      isActiveRole(raw.role) &&
      typeof raw.connectedAt === "number" &&
      typeof raw.lastSeenAt === "number" &&
      typeof raw.transportMode === "string" &&
      typeof raw.transportState === "string" &&
      typeof raw.paused === "boolean" &&
      typeof raw.lastSentSeq === "number" &&
      typeof raw.lastAckedSeq === "number" &&
      typeof raw.unackedBytes === "number" &&
      typeof raw.droppedBytes === "number" &&
      Array.isArray(raw.pendingAcks)
    ) {
      return {
        kind: "active",
        clientId: raw.clientId,
        role: raw.role,
        connectedAt: raw.connectedAt,
        lastSeenAt: raw.lastSeenAt,
        transportMode: raw.transportMode as TransportMode,
        transportState: raw.transportState as TransportState,
        paused: raw.paused,
        lastSentSeq: raw.lastSentSeq,
        lastAckedSeq: raw.lastAckedSeq,
        unackedBytes: raw.unackedBytes,
        droppedBytes: raw.droppedBytes,
        pendingAcks: raw.pendingAcks.filter(isPendingAck),
        // Missing on attachments persisted before host reconnection support.
        ...(typeof raw.superseded === "boolean" ? { superseded: raw.superseded } : {}),
        ...(typeof raw.lastResizeAt === "number" ? { lastResizeAt: raw.lastResizeAt } : {}),
        ...(isRecord(raw.pendingResize) &&
        typeof raw.pendingResize.cols === "number" &&
        typeof raw.pendingResize.rows === "number"
          ? { pendingResize: { cols: raw.pendingResize.cols, rows: raw.pendingResize.rows } }
          : {}),
        ...(typeof raw.lastResyncAt === "number" ? { lastResyncAt: raw.lastResyncAt } : {}),
        ...(typeof raw.cols === "number" ? { cols: raw.cols } : {}),
        ...(typeof raw.rows === "number" ? { rows: raw.rows } : {}),
        // Persisted only after a schema-validated hello; retain as loose objects
        // so new display/client fields survive hibernation without a migration.
        ...(isRecord(raw.client) ? { client: raw.client as ClientDescriptor } : {}),
        ...(isRecord(raw.capabilities) ? { capabilities: raw.capabilities as Capabilities } : {}),
        ...(typeof raw.namespaceId === "string" ? { namespaceId: raw.namespaceId } : {}),
      };
    }
    return null;
  }
  return null;
}

function isPendingAck(value: unknown): value is PendingAck {
  return isRecord(value) && typeof value.seq === "number" && typeof value.bytes === "number";
}

function bufferedAmountOf(ws: WebSocket): number {
  const value = (ws as unknown as { bufferedAmount?: unknown }).bufferedAmount;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isP2pReady(att: ActiveAttachment): boolean {
  return att.transportState === "ready" && att.transportMode.startsWith("p2p");
}

function errorMessage(
  code: ErrorCode,
  message: string,
  requestId?: string,
): Record<string, unknown> {
  const trimmed = message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
  return {
    v: PROTOCOL_VERSION,
    type: "error",
    code,
    message: trimmed.length > 0 ? trimmed : code,
    ...(requestId === undefined ? {} : { requestId }),
  };
}

/**
 * One Durable Object per terminal session.
 *
 * The Worker authenticates the host master token and assigns a role; the DO
 * validates the per-session token in `hello`, owns session state in SQLite, and
 * relays frames/control messages between the host, viewers, and (control-plane
 * only) observers.
 */
export class SessionDurableObject extends DurableObject<RelayEnv> {
  private sessionId = "";
  private readonly logger: Logger;
  private schemaReady = false;
  private purged = false;
  /** Pending trailing-resize timers, keyed by viewer socket. */
  private readonly resizeTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  /** Authoritative relayed-byte counter while this DO instance is awake. */
  private sessionBytes = 0;
  /** Bytes counted since the last `relay_bytes` flush. */
  private sessionBytesUnflushed = 0;
  private sessionBytesLoaded = false;
  /** Inbound active-socket messages inside the rate window. */
  private readonly messageTimestamps: number[] = [];
  /** Last activity-driven idle alarm reschedule; throttled to avoid write amplification. */
  private lastIdleScheduleAt = 0;
  /**
   * Serializes passcode verification/updates. PBKDF2 awaits would otherwise
   * let concurrent hellos read the same failure counter and overwrite each
   * other, defeating the lockout.
   */
  #passcodeQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env);
    // `fetch` is not invoked when a hibernated DO wakes for a WebSocket message,
    // so recover the session name from the Durable Object id as well.
    this.sessionId = ctx.id.name ?? "";
    this.logger = createLogger(env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    // Schema creation is deferred until the first host hello. Anonymous pending
    // sockets and viewers must not instantiate tables for arbitrary sessions.
  }

  private ensureSchema(): void {
    if (!this.schemaReady) {
      ensureRelaySchema(this.ctx.storage.sql);
      this.schemaReady = true;
      this.purged = false;
      // A new/recreated session starts from its persisted counters; a stale
      // in-memory total from a purged session must never leak into it. The rate
      // window is reset as well: otherwise a session purged for a rate breach
      // and recreated on the same DO instance within one second would inherit
      // the old timestamps and close immediately.
      this.sessionBytes = 0;
      this.sessionBytesUnflushed = 0;
      this.sessionBytesLoaded = false;
      this.messageTimestamps.length = 0;
      this.lastIdleScheduleAt = 0;
    }
  }

  private sessionIdFromRequest(request: Request): string | null {
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return null;
    }
    const prefix = "/ws/";
    if (!pathname.startsWith(prefix)) {
      return null;
    }
    const raw = pathname.slice(prefix.length);
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(raw);
    } catch {
      return null;
    }
    return isValidSessionId(sessionId) ? sessionId : null;
  }

  override async fetch(request: Request): Promise<Response> {
    const roleHeader = request.headers.get("x-tokimeki-role");
    if (roleHeader === null) {
      return new Response("missing relay role\n", { status: 400 });
    }
    if (!isActiveRole(roleHeader)) {
      return new Response("invalid relay role\n", { status: 400 });
    }
    const upgrade = request.headers.get("upgrade");
    if (upgrade === null || upgrade.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade\n", { status: 426 });
    }
    const sessionId = this.sessionIdFromRequest(request);
    if (sessionId === null) {
      return new Response("invalid session id\n", { status: 400 });
    }
    // DO instances are addressed by session name; the path must agree. This is
    // defense in depth for any route that can reach the DO without the Worker.
    const expectedSessionId = this.ctx.id.name ?? "";
    if (expectedSessionId.length > 0 && sessionId !== expectedSessionId) {
      return new Response("session id does not match this durable object\n", { status: 400 });
    }
    this.sessionId = sessionId;

    const token = request.headers.get("x-tokimeki-session") ?? "";
    if (token.length === 0) {
      return new Response("missing session token\n", { status: 401 });
    }

    // Bound the total number of OPEN sockets (pending + active) per session so
    // an unauthenticated client cannot accumulate unbounded pending sockets.
    const maxClients =
      loadSessionMetadata(this.ctx.storage.sql)?.maxClients ?? maxClientsPerSession(this.env);
    const openSocketCap = Math.max(1, maxClients) * 2;
    const openSockets = this.ctx
      .getWebSockets()
      .filter((candidate) => candidate.readyState === WebSocket.OPEN).length;
    if (openSockets >= openSocketCap) {
      return new Response("too many connections\n", { status: 429 });
    }

    const tokenHash = await sha256Hex(token);
    // The Worker strips any client-supplied namespace/claim headers and
    // injects them only from a verified host credential or Session JWT.
    const namespaceHeader = request.headers.get("x-tokimeki-namespace");
    const namespaceId =
      namespaceHeader !== null && namespaceHeader.length > 0 ? namespaceHeader : null;
    const sessionClaimHeader = request.headers.get("x-tokimeki-session-claim");
    const sessionClaim =
      sessionClaimHeader !== null && sessionClaimHeader.length > 0 ? sessionClaimHeader : null;
    const sessionScopeHeader = request.headers.get("x-tokimeki-session-scope");
    const sessionScope =
      sessionScopeHeader === "attach" || sessionScopeHeader === "listen"
        ? sessionScopeHeader
        : null;
    const passcodeHeader = request.headers.get("x-tokimeki-passcode");
    const passcode =
      roleHeader !== "host" && passcodeHeader !== null && passcodeHeader.length > 0
        ? passcodeHeader
        : null;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [roleHeader]);
    const now = Date.now();
    this.saveAttachment(server, {
      kind: "pending",
      role: roleHeader as AnyRole,
      connectedAt: now,
      deadline: now + HELLO_TIMEOUT_MS,
      tokenHash,
      namespaceId,
      sessionClaim,
      sessionScope,
      passcode,
    });
    await this.rescheduleAlarm();
    this.logger.info("connection_opened", {
      sessionId: this.sessionId,
      role: roleHeader,
      hasToken: token.length > 0,
      ...(namespaceId === null ? {} : { namespace: namespaceId }),
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = readAttachment(ws);
    if (attachment === null) {
      ws.close(CLOSE_CODES.unauthorized, "unauthorized");
      return;
    }
    const now = Date.now();
    if (attachment.kind === "pending") {
      if (typeof message !== "string") {
        this.closeWithError(
          ws,
          "invalid_message",
          "hello must be a text control message",
          CLOSE_CODES.invalidMessage,
        );
        return;
      }
      await this.handleHello(ws, attachment, message, now);
      return;
    }
    if (attachment.superseded === true) {
      // A newer authenticated host already replaced this socket. Ignore any
      // frames that were queued before the runtime observed the close so a
      // superseded socket can never route output, signals, or lifecycle events.
      return;
    }
    // The per-session message rate is enforced only for authenticated active
    // sockets: an anonymous pending socket must not be able to close a session
    // with a guessed id and an arbitrary token.
    if (this.exceedsMessageRate(now)) {
      await this.closeForQuota("rate");
      return;
    }
    if (typeof message === "string") {
      await this.handleControl(ws, attachment, message, now);
    } else {
      await this.handleBinary(ws, attachment, new Uint8Array(message), now);
    }
  }

  private async handleHello(
    ws: WebSocket,
    pending: PendingAttachment,
    raw: string,
    now: number,
  ): Promise<void> {
    const parsed = safeParseControlMessage(raw);
    if (!parsed.success) {
      this.closeWithError(ws, parsed.error.code, parsed.error.message, CLOSE_CODES.invalidMessage);
      return;
    }
    const message = parsed.data;
    if (message.type !== "hello") {
      this.closeWithError(
        ws,
        "invalid_message",
        "first message must be hello",
        CLOSE_CODES.invalidMessage,
      );
      return;
    }
    const hello = message as HelloMessage;
    if (!isActiveRole(hello.role)) {
      this.closeWithError(ws, "invalid_role", "unsupported role", CLOSE_CODES.invalidMessage);
      return;
    }
    const role: Role = hello.role;
    if (hello.session !== this.sessionId) {
      this.closeWithError(
        ws,
        "invalid_session",
        "hello session does not match this relay path",
        CLOSE_CODES.unauthorized,
      );
      return;
    }
    if (role !== pending.role) {
      this.closeWithError(
        ws,
        "invalid_role",
        "hello role does not match the relay-assigned role",
        CLOSE_CODES.invalidMessage,
      );
      return;
    }
    if (pending.tokenHash.length === 0) {
      this.closeWithError(ws, "unauthorized", "missing session token", CLOSE_CODES.unauthorized);
      return;
    }

    // A verified Session JWT bypasses only the opaque host-token comparison.
    // Session, namespace, and scope are re-checked here because the DO is the
    // last line of defense for internal headers.
    if (pending.sessionClaim !== null) {
      if (role === "host") {
        this.closeWithError(
          ws,
          "unauthorized",
          "a session jwt is not a host credential",
          CLOSE_CODES.unauthorized,
        );
        return;
      }
      if (
        pending.namespaceId === null ||
        pending.namespaceId === "*" ||
        pending.sessionScope === null
      ) {
        this.closeWithError(
          ws,
          "unauthorized",
          "session jwt is missing namespace or scope",
          CLOSE_CODES.unauthorized,
        );
        return;
      }
      if (pending.sessionClaim !== hello.session) {
        this.closeWithError(
          ws,
          "invalid_session",
          "session jwt claim does not match this relay path",
          CLOSE_CODES.unauthorized,
        );
        return;
      }
      if (!isNamespaceSessionId(hello.session, pending.namespaceId)) {
        this.closeWithError(
          ws,
          "invalid_session",
          "session does not belong to the session jwt namespace",
          CLOSE_CODES.unauthorized,
        );
        return;
      }
      if (pending.sessionScope === "listen" && role !== "listener") {
        this.closeWithError(
          ws,
          "invalid_role",
          "listen scope requires the listener role",
          CLOSE_CODES.unauthorized,
        );
        return;
      }
      if (pending.sessionScope === "attach" && role !== "viewer") {
        this.closeWithError(
          ws,
          "invalid_role",
          "attach scope requires the viewer role",
          CLOSE_CODES.unauthorized,
        );
        return;
      }
    }

    // The effective namespace is derived only from the Worker-injected header:
    // `"*"` is the root master, a concrete name is a namespace token, and the
    // session id must carry the same `<namespace>.<slug>` prefix.
    if (role === "host" && pending.namespaceId !== null && pending.namespaceId !== "*") {
      if (!isNamespaceSessionId(hello.session, pending.namespaceId)) {
        this.closeWithError(
          ws,
          "invalid_session",
          "session does not belong to the host namespace",
          CLOSE_CODES.unauthorized,
        );
        return;
      }
    }
    const resolvedNamespaceId: string | null =
      pending.namespaceId === "*"
        ? deriveNamespaceFromSessionId(hello.session)
        : pending.namespaceId;

    // Fast-path duplicate check. Host duplicates are deferred until the token is
    // verified: an authenticated host may replace a stale host socket or a
    // viewer that squatted its client id while the host was offline (SEC-09).
    const existing = this.findActive(hello.clientId);
    if (existing !== null && role !== "host") {
      this.closeWithError(
        ws,
        "duplicate_client_id",
        "client id is already connected to this session",
        CLOSE_CODES.invalidMessage,
      );
      return;
    }

    if (role === "host") {
      // Only a host hello may create the relay schema. Anonymous pending
      // sockets and viewers must not instantiate tables for arbitrary sessions
      // (SEC-01).
      this.ensureSchema();
    }
    const meta = loadSessionMetadata(this.ctx.storage.sql);

    if (role === "host") {
      if (meta === null) {
        if (existing !== null || this.isHostOnline()) {
          // No persisted host token exists, so a replacement cannot be
          // authenticated; fall back to the duplicate-client-id rejection.
          this.closeWithError(
            ws,
            "duplicate_client_id",
            "client id is already connected to this session",
            CLOSE_CODES.invalidMessage,
          );
          return;
        }
      } else {
        const tokenMatches = await constantTimeEqualHex(meta.hostTokenHash, pending.tokenHash);
        if (!tokenMatches) {
          // Never touch the live host before the token is verified.
          this.closeWithError(
            ws,
            "unauthorized",
            "host session token does not match",
            CLOSE_CODES.unauthorized,
          );
          return;
        }
        // Root hosts may take over any session; a namespace host only its own
        // namespace; a namespace-less (legacy/direct) host never a namespaced
        // session. A legacy row is `namespaceId: null` and stays root-only.
        if (pending.namespaceId !== "*" && meta.namespaceId !== pending.namespaceId) {
          this.closeWithError(
            ws,
            "invalid_session",
            "host namespace does not match this session",
            CLOSE_CODES.unauthorized,
          );
          return;
        }
        const onlineHost = this.findHost();
        if (onlineHost !== null && onlineHost.att.clientId !== hello.clientId) {
          this.closeWithError(
            ws,
            "duplicate_client_id",
            "a host is already online for this session",
            CLOSE_CODES.invalidMessage,
          );
          return;
        }
      }
    } else {
      if (meta === null) {
        this.closeWithError(
          ws,
          "invalid_session",
          "session does not exist; the host must connect first",
          CLOSE_CODES.unauthorized,
        );
        return;
      }
      if (pending.sessionClaim !== null) {
        // A Session JWT needs a namespace-scoped session row; legacy
        // `namespace_id=NULL` sessions have no trustworthy namespace and must
        // keep accepting only the opaque session token.
        if (meta.namespaceId === null || meta.namespaceId !== pending.namespaceId) {
          this.closeWithError(
            ws,
            "invalid_session",
            "session jwt namespace does not match this session",
            CLOSE_CODES.unauthorized,
          );
          return;
        }
      } else {
        const tokenMatches = await constantTimeEqualHex(meta.hostTokenHash, pending.tokenHash);
        if (!tokenMatches) {
          this.closeWithError(
            ws,
            "unauthorized",
            "session token does not match",
            CLOSE_CODES.unauthorized,
          );
          return;
        }
      }
      // Defense in depth: a session created under a namespace must only ever
      // accept connections on its own `<namespace>.<slug>` path.
      if (meta.namespaceId !== null && !isNamespaceSessionId(hello.session, meta.namespaceId)) {
        this.closeWithError(
          ws,
          "invalid_session",
          "session prefix does not match its namespace",
          CLOSE_CODES.unauthorized,
        );
        return;
      }
    }

    // The token check yields to the runtime. Re-read session state and recheck
    // duplicates/capacity synchronously before saving the attachment so two
    // concurrent hellos cannot both pass the pre-await checks (SEC-02).
    let latestMeta = loadSessionMetadata(this.ctx.storage.sql);
    if (latestMeta !== null && meta !== null && latestMeta.hostTokenHash !== meta.hostTokenHash) {
      this.closeWithError(
        ws,
        "unauthorized",
        "session token changed during hello",
        CLOSE_CODES.unauthorized,
      );
      return;
    }
    if (
      latestMeta !== null &&
      role === "host" &&
      pending.namespaceId !== "*" &&
      latestMeta.namespaceId !== pending.namespaceId
    ) {
      this.closeWithError(
        ws,
        "invalid_session",
        "session namespace changed during hello",
        CLOSE_CODES.unauthorized,
      );
      return;
    }
    // The absolute lifetime cannot be extended by a reconnect. If the alarm
    // has not run yet, an authenticated hello is the next authoritative point
    // to enforce it. The persisted deadline is ignored while the cap is
    // disabled, so `TOKIMEKI_SESSION_MAX_TTL_SECONDS=0` rolls back cleanly.
    if (
      sessionMaxTtlSeconds(this.env) > 0 &&
      latestMeta !== null &&
      latestMeta.absoluteDeadline !== null &&
      latestMeta.absoluteDeadline <= now
    ) {
      await this.purgeSession("absolute_ttl");
      return;
    }
    if (!(await this.serializePasscode(() => this.handlePasscode(ws, role, hello, pending, now)))) {
      return;
    }

    // The passcode check awaits PBKDF2. Another host can create the session in
    // that window, so re-read and re-run every host check against fresh state
    // before deciding whether to insert. Otherwise a host credential holder
    // without this session token could overwrite a brand-new session's hash,
    // TTL, and quotas with `INSERT OR REPLACE`.
    latestMeta = loadSessionMetadata(this.ctx.storage.sql);
    if (latestMeta !== null && meta !== null && latestMeta.hostTokenHash !== meta.hostTokenHash) {
      this.closeWithError(
        ws,
        "unauthorized",
        "session token changed during hello",
        CLOSE_CODES.unauthorized,
      );
      return;
    }
    if (role === "host" && meta === null && latestMeta !== null) {
      const tokenMatches = await constantTimeEqualHex(latestMeta.hostTokenHash, pending.tokenHash);
      if (!tokenMatches) {
        this.closeWithError(
          ws,
          "unauthorized",
          "session token does not match",
          CLOSE_CODES.unauthorized,
        );
        return;
      }
    }
    if (
      latestMeta !== null &&
      role === "host" &&
      pending.namespaceId !== "*" &&
      latestMeta.namespaceId !== pending.namespaceId
    ) {
      this.closeWithError(
        ws,
        "invalid_session",
        "session namespace changed during hello",
        CLOSE_CODES.unauthorized,
      );
      return;
    }
    if (
      sessionMaxTtlSeconds(this.env) > 0 &&
      latestMeta !== null &&
      latestMeta.absoluteDeadline !== null &&
      latestMeta.absoluteDeadline <= now
    ) {
      await this.purgeSession("absolute_ttl");
      return;
    }

    const latestExisting = this.findActive(hello.clientId);
    let replacedSocket: ActiveSocket | null = null;

    if (role === "host") {
      if (latestMeta !== null) {
        const onlineHost = this.findHost();
        if (onlineHost !== null && onlineHost.att.clientId !== hello.clientId) {
          this.closeWithError(
            ws,
            "duplicate_client_id",
            "a host is already online for this session",
            CLOSE_CODES.invalidMessage,
          );
          return;
        }
      } else if (latestExisting !== null) {
        this.closeWithError(
          ws,
          "duplicate_client_id",
          "client id is already connected to this session",
          CLOSE_CODES.invalidMessage,
        );
        return;
      }
      replacedSocket = latestExisting;
    } else if (latestMeta === null) {
      this.closeWithError(
        ws,
        "invalid_session",
        "session does not exist; the host must connect first",
        CLOSE_CODES.unauthorized,
      );
      return;
    } else if (latestExisting !== null) {
      this.closeWithError(
        ws,
        "duplicate_client_id",
        "client id is already connected to this session",
        CLOSE_CODES.invalidMessage,
      );
      return;
    }

    // Check capacity after authentication. The socket being replaced no longer
    // counts, so a full session can still recover its host.
    const maxClients = latestMeta?.maxClients ?? maxClientsPerSession(this.env);
    const effectiveClients = this.activeSockets().length - (replacedSocket === null ? 0 : 1);
    if (effectiveClients >= maxClients) {
      this.closeWithError(
        ws,
        "session_full",
        "session has reached its client limit",
        CLOSE_CODES.sessionFull,
      );
      return;
    }
    // Listeners have an independent cap on top of the total client limit so a
    // snapshot fan-out cannot crowd out viewers.
    if (role === "listener") {
      const listenerCount = this.activeSockets().filter(
        (socket) => socket.att.role === "listener",
      ).length;
      if (listenerCount >= maxListenersPerSession(this.env)) {
        this.closeWithError(
          ws,
          "session_full",
          "session has reached its listener limit",
          CLOSE_CODES.sessionFull,
        );
        return;
      }
    }

    if (role === "host") {
      const maxTtl = sessionMaxTtlSeconds(this.env);
      if (latestMeta === null) {
        insertSessionMetadata(this.ctx.storage.sql, {
          sessionId: this.sessionId,
          createdAt: now,
          lastActivityAt: now,
          hostTokenHash: pending.tokenHash,
          sessionTtlSeconds: sessionTtlSeconds(this.env),
          maxClients,
          hostOfflineDeadline: null,
          namespaceId: resolvedNamespaceId,
          absoluteDeadline: maxTtl > 0 ? now + maxTtl * 1000 : null,
          relayBytes: 0,
        });
        // `INSERT OR IGNORE`: if another first host won the race, verify the
        // persisted hash before this socket becomes an active host.
        const created = loadSessionMetadata(this.ctx.storage.sql);
        if (created === null) {
          this.closeWithError(
            ws,
            "internal",
            "failed to create session metadata",
            CLOSE_CODES.internalError,
          );
          return;
        }
        if (!(await constantTimeEqualHex(created.hostTokenHash, pending.tokenHash))) {
          this.closeWithError(
            ws,
            "unauthorized",
            "session token does not match",
            CLOSE_CODES.unauthorized,
          );
          return;
        }
        latestMeta = created;
      } else if (replacedSocket !== null) {
        this.supersedeSocket(
          replacedSocket,
          replacedSocket.att.role === "host" ? "host-reconnect" : "host-takeover",
        );
      }
      // A legacy row created before absolute TTLs existed gets one full window
      // on its next host hello; once set it is never extended again.
      if (latestMeta !== null && latestMeta.absoluteDeadline === null && maxTtl > 0) {
        setAbsoluteDeadline(this.ctx.storage.sql, now + maxTtl * 1000);
      }
      // A new host means the session is live again: clear the offline TTL and
      // any stale exit marker. These writes run only after the capacity check
      // so a rejected host cannot keep the session alive forever.
      setHostOfflineDeadline(this.ctx.storage.sql, null);
      clearHostExit(this.ctx.storage.sql);
    }

    const client = boundedClientDescriptor(hello.client);
    const displayCapabilities = boundedCapabilities(hello.capabilities);
    const active: ActiveAttachment = {
      kind: "active",
      clientId: hello.clientId,
      role,
      connectedAt: now,
      lastSeenAt: now,
      transportMode: "relay",
      transportState: "ready",
      paused: false,
      lastSentSeq: 0,
      lastAckedSeq: 0,
      unackedBytes: 0,
      droppedBytes: 0,
      pendingAcks: [],
      ...(hello.cols === undefined ? {} : { cols: hello.cols }),
      ...(hello.rows === undefined ? {} : { rows: hello.rows }),
      ...(client === undefined ? {} : { client }),
      ...(displayCapabilities === undefined ? {} : { capabilities: displayCapabilities }),
      ...(role === "host" && resolvedNamespaceId !== null
        ? { namespaceId: resolvedNamespaceId }
        : {}),
    };
    this.saveAttachment(ws, active);
    updateLastActivity(this.ctx.storage.sql, now);

    // Listeners receive snapshots only. They can never use P2P/TURN, so they
    // must never receive TURN credentials either.
    const ice =
      role === "listener"
        ? stunOnlyIceConfig(this.env)
        : await issueIceConfig({
            env: this.env,
            clientId: active.clientId,
            sql: this.ctx.storage.sql,
          });
    if (ice.fallbackReason !== undefined) {
      this.logger.warn("turn_fallback", {
        sessionId: this.sessionId,
        reason: ice.fallbackReason,
        fallback: ice.iceProvider,
      });
    }
    const sessionMeta = loadSessionMetadata(this.ctx.storage.sql);
    const welcome = {
      v: PROTOCOL_VERSION,
      type: "welcome",
      session: this.sessionId,
      protocolVersion: PROTOCOL_VERSION,
      hostOnline: this.isHostOnline(),
      clients: this.currentClients(ws),
      iceServers: ice.iceServers,
      iceProvider: ice.iceProvider,
      iceExpiresAt: ice.iceExpiresAt,
      transportPolicy: iceTransportPolicy(this.env),
      sessionTtlSeconds: sessionMeta?.sessionTtlSeconds ?? sessionTtlSeconds(this.env),
      capabilities: RELAY_CAPABILITIES,
    };
    this.sendControl(ws, welcome);

    if (role !== "host") {
      // A viewer may reconnect after the host's exit broadcast. Replay the
      // persisted lifecycle event so it does not wait for a host that is gone.
      const hostExit = loadHostExit(this.ctx.storage.sql);
      if (hostExit !== null) {
        this.sendControl(ws, {
          v: PROTOCOL_VERSION,
          type: "host-exited",
          ...(hostExit.exitCode === null ? {} : { exitCode: hostExit.exitCode }),
          ...(hostExit.signal === null ? {} : { signal: hostExit.signal }),
        });
      }
    }

    if (
      role === "viewer" &&
      hello.cols !== undefined &&
      hello.rows !== undefined &&
      isTerminalSizeWithinLimits(hello.cols, hello.rows)
    ) {
      // Only viewers drive PTY sizing. Echoing the host's own hello size back
      // would make the host treat itself as a viewer, and observer/agent sizes
      // must not resize the hosted terminal.
      const host = this.findHost();
      if (host !== null) {
        this.sendControl(host.ws, {
          v: PROTOCOL_VERSION,
          type: "resize",
          clientId: active.clientId,
          cols: hello.cols,
          rows: hello.rows,
        });
      }
    }

    const others = this.activeSockets().filter((candidate) => candidate.ws !== ws);
    if (role === "host") {
      for (const other of others) {
        this.sendControl(other.ws, {
          v: PROTOCOL_VERSION,
          type: "host",
          online: true,
        });
      }
    } else {
      const host = this.findHost();
      if (host !== null) {
        this.sendControl(host.ws, {
          v: PROTOCOL_VERSION,
          type: "peer-joined",
          clientId: active.clientId,
          role: active.role,
          capabilities: hello.capabilities,
        });
      }
    }
    this.broadcastTo(others, {
      v: PROTOCOL_VERSION,
      type: "presence",
      clients: this.currentClients(),
    });

    this.logger.info("hello_accepted", {
      sessionId: this.sessionId,
      clientId: active.clientId,
      role: active.role,
      clientCount: this.activeSockets().length,
      ...(active.namespaceId === undefined ? {} : { namespace: active.namespaceId }),
    });
    await this.rescheduleAlarm();
  }

  private async handleControl(
    ws: WebSocket,
    att: ActiveAttachment,
    raw: string,
    now: number,
  ): Promise<void> {
    const parsed = safeParseControlMessage(raw);
    if (!parsed.success) {
      this.sendControl(ws, errorMessage(parsed.error.code, parsed.error.message));
      return;
    }
    const message: ControlMessage = parsed.data;
    if (message.type === "hello") {
      this.sendControl(ws, errorMessage("invalid_message", "hello was already accepted"));
      return;
    }
    if (isAgentMessage(message)) {
      this.replyAgentNotImplemented(ws, message);
      this.touch(ws, att, now);
      return;
    }
    if (att.role === "agent") {
      this.sendControl(
        ws,
        errorMessage("invalid_role", "agent role only carries agent.* messages"),
      );
      return;
    }
    const known = message as KnownControlMessage;
    switch (known.type) {
      case "ping":
        this.sendControl(ws, {
          v: PROTOCOL_VERSION,
          type: "pong",
          ...(known.ts === undefined ? {} : { ts: known.ts }),
        });
        break;
      case "ack":
        if (att.role === "listener") {
          this.sendControl(
            ws,
            errorMessage("invalid_role", "listeners do not acknowledge terminal output"),
          );
          break;
        }
        this.handleAck(ws, att, known.seq);
        break;
      case "signal":
        if (att.role === "observer" || att.role === "listener") {
          this.sendControl(
            ws,
            errorMessage("invalid_role", `${att.role} role cannot exchange signals`),
          );
          break;
        }
        this.routeSignal(ws, att, known);
        break;
      case "transport":
        if (att.role === "observer" || att.role === "listener") {
          this.sendControl(
            ws,
            errorMessage("invalid_role", `${att.role} role cannot select a transport`),
          );
          break;
        }
        this.updateTransport(ws, att, known);
        break;
      case "resize":
        if (att.role !== "viewer") {
          this.sendControl(ws, errorMessage("invalid_role", "only viewers may send resize"));
          break;
        }
        this.routeResize(ws, att, known);
        break;
      case "resync":
        if (att.role !== "viewer") {
          this.sendControl(ws, errorMessage("invalid_role", "only viewers may send resync"));
          break;
        }
        this.routeResync(ws, att, known);
        break;
      case "ice-refresh":
        await this.handleIceRefresh(ws, att, known.provider);
        break;
      case "host-exited":
        this.routeHostExited(ws, att, known);
        break;
      default:
        this.sendControl(
          ws,
          errorMessage(
            "invalid_message",
            SERVER_OWNED_CONTROL_TYPES.has(known.type)
              ? `server-owned control message ${known.type} is not accepted from clients`
              : `control message ${known.type} is not accepted from clients`,
          ),
        );
        break;
    }
    this.touch(ws, att, now);
  }

  private replyAgentNotImplemented(ws: WebSocket, message: AgentMessage): void {
    this.sendControl(
      ws,
      createNotImplementedErrorMessage({
        ...(message.requestId === undefined ? {} : { requestId: message.requestId }),
        detail: "agent namespace",
      }),
    );
  }

  private handleAck(ws: WebSocket, att: ActiveAttachment, seq: string): void {
    if (att.role === "listener") {
      // Listeners receive snapshots only and are outside ACK/backpressure
      // accounting; never let one mutate a viewer's pending ACK state.
      this.sendControl(
        ws,
        errorMessage("invalid_role", "listeners do not acknowledge terminal output"),
      );
      return;
    }
    let ackSeq: number;
    try {
      ackSeq = u64StringToNumber(seq);
    } catch {
      this.sendControl(ws, errorMessage("invalid_message", "ack seq is not a safe u64"));
      return;
    }
    for (;;) {
      const head = att.pendingAcks[0];
      if (head === undefined || head.seq > ackSeq) {
        break;
      }
      att.pendingAcks.shift();
      att.unackedBytes = Math.max(0, att.unackedBytes - head.bytes);
    }
    att.lastAckedSeq = Math.max(att.lastAckedSeq, ackSeq);
    if (
      att.paused &&
      att.unackedBytes <= FLOW_LOW_WATER_BYTES &&
      bufferedAmountOf(ws) < RUNTIME_PAUSE_BUFFERED_BYTES
    ) {
      att.paused = false;
      att.droppedBytes = 0;
      this.saveAttachment(ws, att);
      this.notifyHostFlow(att.clientId, "resume");
      return;
    }
    this.saveAttachment(ws, att);
  }

  private routeSignal(
    ws: WebSocket,
    att: ActiveAttachment,
    message: Extract<KnownControlMessage, { type: "signal" }>,
  ): void {
    const target = this.findActive(message.to);
    if (target === null) {
      this.sendControl(ws, errorMessage("invalid_target", "signal target is not connected"));
      return;
    }
    // Signaling is only defined between the host and a viewer; relaying it
    // viewer→viewer would let one viewer open a WebRTC peer to another and
    // bypass the host's per-viewer transport ownership.
    const senderIsHost = att.role === "host";
    const targetIsHost = target.att.role === "host";
    const targetIsViewer = target.att.role === "viewer";
    if (!((senderIsHost && targetIsViewer) || (att.role === "viewer" && targetIsHost))) {
      this.sendControl(
        ws,
        errorMessage("invalid_role", "signals are only relayed between the host and a viewer"),
      );
      return;
    }
    this.sendControl(target.ws, {
      v: PROTOCOL_VERSION,
      type: "signal",
      to: message.to,
      from: att.clientId,
      kind: message.kind,
      payload: message.payload,
    });
  }

  private updateTransport(
    ws: WebSocket,
    att: ActiveAttachment,
    message: Extract<KnownControlMessage, { type: "transport" }>,
  ): void {
    if (att.role === "listener") {
      this.sendControl(
        ws,
        errorMessage("invalid_role", "listeners always use the relay transport"),
      );
      return;
    }
    let targetWs = ws;
    let targetAtt = att;
    if (message.clientId !== att.clientId) {
      // The host is authoritative for each viewer's transport selection; other
      // clients may only announce their own.
      if (att.role !== "host") {
        this.sendControl(
          ws,
          errorMessage("invalid_message", "clients may only update their own transport"),
        );
        return;
      }
      const target = this.findActive(message.clientId);
      if (target === null) {
        this.sendControl(ws, errorMessage("invalid_target", "transport target is not connected"));
        return;
      }
      if (target.att.role === "listener") {
        // Listeners never participate in P2P; keep their transport pinned to
        // the relay so host/viewer transport bookkeeping stays consistent.
        this.sendControl(
          ws,
          errorMessage("invalid_role", "listener transport is fixed to the relay"),
        );
        return;
      }
      targetWs = target.ws;
      targetAtt = target.att;
    }
    targetAtt.transportMode = message.mode;
    targetAtt.transportState = message.state;
    if (targetAtt.paused && isP2pReady(targetAtt)) {
      targetAtt.paused = false;
      targetAtt.droppedBytes = 0;
      // The switch may be announced by the host itself (`message.clientId ===
      // att.clientId`); the host still has a `relay:<clientId>` pause tag to
      // clear, so always echo the resume.
      this.notifyHostFlow(targetAtt.clientId, "resume");
    }
    this.saveAttachment(targetWs, targetAtt);
    this.broadcastTo(
      this.activeSockets().filter((candidate) => candidate.ws !== ws),
      {
        v: PROTOCOL_VERSION,
        type: "transport",
        clientId: targetAtt.clientId,
        mode: message.mode,
        state: message.state,
        ...(message.reason === undefined ? {} : { reason: message.reason }),
        ...(message.via === undefined ? {} : { via: message.via }),
      },
    );
  }

  /**
   * `host-exited` is server-owned toward viewers, but the host is the only
   * source of truth for the PTY exit status. Accept it from the host only and
   * fan it out on the control plane; viewers that sent it would be spoofing
   * the host's lifecycle.
   */
  private routeHostExited(
    ws: WebSocket,
    att: ActiveAttachment,
    message: Extract<KnownControlMessage, { type: "host-exited" }>,
  ): void {
    if (att.role !== "host") {
      this.sendControl(ws, errorMessage("invalid_role", "only the host may send host-exited"));
      return;
    }
    saveHostExit(this.ctx.storage.sql, this.sessionId, {
      hostExitedAt: Date.now(),
      exitCode: message.exitCode ?? null,
      signal: message.signal ?? null,
    });
    this.broadcastTo(
      this.activeSockets().filter((candidate) => candidate.att.role !== "host"),
      {
        v: PROTOCOL_VERSION,
        type: "host-exited",
        ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
        ...(message.signal === undefined ? {} : { signal: message.signal }),
      },
    );
    this.logger.info("host_exited", {
      sessionId: this.sessionId,
      exitCode: message.exitCode ?? null,
      signal: message.signal ?? null,
    });
  }

  private routeResize(
    ws: WebSocket,
    att: ActiveAttachment,
    message: Extract<KnownControlMessage, { type: "resize" }>,
  ): void {
    if (!isTerminalSizeWithinLimits(message.cols, message.rows)) {
      this.sendControl(ws, errorMessage("invalid_message", "terminal size exceeds the cell limit"));
      return;
    }
    const host = this.findHost();
    if (host === null) {
      this.sendControl(ws, errorMessage("host_offline", "host is not connected"));
      return;
    }
    const now = Date.now();
    const last = att.lastResizeAt ?? 0;
    if (now - last < RESIZE_THROTTLE_MS) {
      // Keep only the latest size in the window; a trailing timer forwards it
      // so the host still receives the final size after a drag-resize burst.
      att.pendingResize = { cols: message.cols, rows: message.rows };
      this.saveAttachment(ws, att);
      this.scheduleTrailingResize(ws);
      return;
    }
    att.lastResizeAt = now;
    att.pendingResize = undefined;
    this.saveAttachment(ws, att);
    this.sendControl(host.ws, {
      v: PROTOCOL_VERSION,
      type: "resize",
      clientId: att.clientId,
      cols: message.cols,
      rows: message.rows,
    });
  }

  private scheduleTrailingResize(ws: WebSocket): void {
    if (this.resizeTimers.has(ws)) {
      return;
    }
    const timer = setTimeout(() => {
      this.resizeTimers.delete(ws);
      const attachment = readAttachment(ws);
      if (attachment === null || attachment.kind !== "active" || attachment.superseded === true) {
        return;
      }
      const pending = attachment.pendingResize;
      if (pending === undefined) {
        return;
      }
      const host = this.findHost();
      if (host === null) {
        return;
      }
      attachment.pendingResize = undefined;
      attachment.lastResizeAt = Date.now();
      this.saveAttachment(ws, attachment);
      this.sendControl(host.ws, {
        v: PROTOCOL_VERSION,
        type: "resize",
        clientId: attachment.clientId,
        cols: pending.cols,
        rows: pending.rows,
      });
    }, RESIZE_THROTTLE_MS);
    this.resizeTimers.set(ws, timer);
  }

  private routeResync(
    ws: WebSocket,
    att: ActiveAttachment,
    message: Extract<KnownControlMessage, { type: "resync" }>,
  ): void {
    const host = this.findHost();
    if (host === null) {
      this.sendControl(ws, errorMessage("host_offline", "host is not connected"));
      return;
    }
    this.forwardResync(ws, att, host, message.fromSeq);
  }

  private forwardResync(
    ws: WebSocket,
    att: ActiveAttachment,
    host: ActiveSocket,
    fromSeq?: string,
  ): void {
    const now = Date.now();
    const last = att.lastResyncAt ?? 0;
    if (now - last < RESYNC_THROTTLE_MS) {
      // Drop duplicate resyncs inside the window instead of amplifying them
      // into full snapshots on the host and every viewer.
      this.logger.debug("resync_throttled", {
        sessionId: this.sessionId,
        clientId: att.clientId,
      });
      return;
    }
    att.lastResyncAt = now;
    this.saveAttachment(ws, att);
    this.sendControl(host.ws, {
      v: PROTOCOL_VERSION,
      type: "resync",
      clientId: att.clientId,
      ...(fromSeq === undefined ? {} : { fromSeq }),
    });
  }

  private async handleIceRefresh(
    ws: WebSocket,
    att: ActiveAttachment,
    requestedProvider: IceProvider | undefined,
  ): Promise<void> {
    if (att.role === "listener") {
      this.sendControl(
        ws,
        errorMessage("invalid_role", "listeners do not receive TURN credentials"),
      );
      return;
    }
    const ice = await issueIceConfig({
      env: this.env,
      clientId: att.clientId,
      sql: this.ctx.storage.sql,
      ...(requestedProvider === undefined ? {} : { requestedProvider }),
    });
    if (ice.fallbackReason !== undefined) {
      this.logger.warn("turn_fallback", {
        sessionId: this.sessionId,
        reason: ice.fallbackReason,
        fallback: ice.iceProvider,
        requestedProvider: requestedProvider ?? null,
      });
    }
    this.sendControl(ws, {
      v: PROTOCOL_VERSION,
      type: "ice",
      iceServers: ice.iceServers,
      iceProvider: ice.iceProvider,
      iceExpiresAt: ice.iceExpiresAt,
    });
    this.logger.debug("ice_refreshed", {
      sessionId: this.sessionId,
      clientId: att.clientId,
      provider: ice.iceProvider,
      requestedProvider: requestedProvider ?? null,
    });
  }

  private async handleBinary(
    ws: WebSocket,
    att: ActiveAttachment,
    bytes: Uint8Array,
    now: number,
  ): Promise<void> {
    let frame: ReturnType<typeof decodeFrame>;
    try {
      frame = decodeFrame(bytes);
    } catch (error) {
      if (error instanceof ProtocolFrameError) {
        const code: ErrorCode =
          error.code === "frame_too_large"
            ? "frame_too_large"
            : error.code === "invalid_target_id"
              ? "invalid_target"
              : "invalid_frame";
        this.sendControl(ws, errorMessage(code, `invalid binary frame: ${error.code}`));
      } else {
        this.sendControl(ws, errorMessage("invalid_frame", "invalid binary frame"));
      }
      return;
    }

    if (frame.type === "tunnel" || frame.type === "tunnel_to") {
      this.sendControl(ws, createNotImplementedErrorMessage({ detail: "binary tunnel frames" }));
      return;
    }

    // Count relay-delivered terminal frames exactly once per session: host
    // OUTPUT/SNAPSHOT_TO and viewer INPUT. Invalid frames, control messages,
    // TUNNEL records, and P2P/TUN data are outside this budget.
    const relayed =
      (att.role === "host" && (frame.type === "output" || frame.type === "snapshot_to")) ||
      (att.role === "viewer" && frame.type === "input");
    if (relayed && (await this.recordRelayBytes(bytes.byteLength))) {
      return;
    }

    switch (att.role) {
      case "host":
        this.handleHostFrame(ws, frame, bytes);
        break;
      case "viewer":
        this.handleViewerFrame(ws, att, frame, bytes);
        break;
      default:
        this.sendControl(
          ws,
          errorMessage("invalid_role", `${att.role} role cannot send terminal frames`),
        );
        break;
    }
    this.touch(ws, att, now);
  }

  private handleHostFrame(
    ws: WebSocket,
    frame: ReturnType<typeof decodeFrame>,
    bytes: Uint8Array,
  ): void {
    switch (frame.type) {
      case "output":
        this.forwardOutput(frame.seq, bytes);
        break;
      case "snapshot_to": {
        const target = this.findActive(frame.targetId);
        if (target === null) {
          this.sendControl(
            ws,
            errorMessage("invalid_target", "SNAPSHOT_TO target is not connected"),
          );
          return;
        }
        if (target.att.role === "listener") {
          // Snapshot-only delivery: no ACK ring, no unacked/hard-limit
          // accounting, and no host pause. A dropped snapshot is replaced by
          // the next periodic one instead of closing the listener.
          this.deliverListenerSnapshot(target.ws, target.att, bytes);
          break;
        }
        if (target.att.role !== "viewer") {
          this.sendControl(
            ws,
            errorMessage("invalid_target", "SNAPSHOT_TO target is not a connected viewer"),
          );
          return;
        }
        this.deliverOutput(target.ws, target.att, frame.seq, bytes, true);
        break;
      }
      case "snapshot":
        this.sendControl(
          ws,
          errorMessage(
            "invalid_frame",
            "SNAPSHOT is only valid over a direct P2P transport; use SNAPSHOT_TO over the relay",
          ),
        );
        break;
      case "input":
      case "resync_req":
        this.sendControl(ws, errorMessage("invalid_role", `host cannot send ${frame.type} frames`));
        break;
      default:
        this.sendControl(ws, errorMessage("invalid_frame", "unsupported frame"));
        break;
    }
  }

  private handleViewerFrame(
    ws: WebSocket,
    att: ActiveAttachment,
    frame: ReturnType<typeof decodeFrame>,
    bytes: Uint8Array,
  ): void {
    switch (frame.type) {
      case "input": {
        const host = this.findHost();
        if (host === null) {
          this.sendControl(ws, errorMessage("host_offline", "host is not connected"));
          return;
        }
        this.sendBinary(host.ws, bytes);
        break;
      }
      case "resync_req": {
        const host = this.findHost();
        if (host === null) {
          this.sendControl(ws, errorMessage("host_offline", "host is not connected"));
          return;
        }
        // Convert the raw binary request into a targeted JSON resync so the
        // host snapshots only this viewer and relay-level throttling applies.
        this.forwardResync(ws, att, host);
        break;
      }
      case "output":
      case "snapshot":
      case "snapshot_to":
        this.sendControl(
          ws,
          errorMessage(
            "invalid_role",
            `viewer cannot send ${frame.type}; only the host produces terminal output`,
          ),
        );
        break;
      default:
        this.sendControl(ws, errorMessage("invalid_frame", "unsupported frame"));
        break;
    }
  }

  private forwardOutput(seq: number, bytes: Uint8Array): void {
    for (const viewer of this.activeSockets()) {
      if (viewer.att.role !== "viewer" || isP2pReady(viewer.att)) {
        continue;
      }
      this.deliverOutput(viewer.ws, viewer.att, seq, bytes);
    }
  }

  private deliverOutput(
    viewerWs: WebSocket,
    att: ActiveAttachment,
    seq: number,
    bytes: Uint8Array,
    recoverySnapshot = false,
  ): void {
    if (att.paused && !recoverySnapshot) {
      att.droppedBytes += bytes.byteLength;
      if (att.unackedBytes + att.droppedBytes >= FLOW_HARD_LIMIT_BYTES) {
        this.closeSlowConsumer(viewerWs, att);
        return;
      }
      this.saveAttachment(viewerWs, att);
      return;
    }
    // `recoverySnapshot` bypasses the pause gate above: a snapshot is the
    // viewer's only way to re-bind its output sequence after a dropped gap.
    // Dropping it strands the viewer, because once the host stops producing
    // output there is nothing left to trigger another resync. The snapshot ACK
    // still clears the pause through the normal low-water path.

    if (!this.sendBinary(viewerWs, bytes)) {
      return;
    }
    att.lastSentSeq = Math.max(att.lastSentSeq, seq);
    att.pendingAcks.push({ seq, bytes: bytes.byteLength });
    att.unackedBytes += bytes.byteLength;
    while (att.pendingAcks.length > ACK_RING_LIMIT) {
      const evicted = att.pendingAcks.shift();
      if (evicted !== undefined) {
        att.unackedBytes = Math.max(0, att.unackedBytes - evicted.bytes);
      }
    }

    const buffered = bufferedAmountOf(viewerWs);
    if (att.unackedBytes + att.droppedBytes >= FLOW_HARD_LIMIT_BYTES) {
      this.closeSlowConsumer(viewerWs, att);
      return;
    }
    if (
      !att.paused &&
      (att.unackedBytes >= FLOW_HIGH_WATER_BYTES || buffered >= RUNTIME_PAUSE_BUFFERED_BYTES)
    ) {
      att.paused = true;
      this.notifyHostFlow(att.clientId, "pause");
    }
    this.saveAttachment(viewerWs, att);
  }

  /**
   * Deliver a host-directed snapshot to a read-only listener.
   *
   * Listeners never ACK, so this path must not touch `pendingAcks`,
   * `unackedBytes`, `droppedBytes`, or the pause state. When the listener's
   * socket buffer is already high the snapshot is dropped and the next
   * periodic snapshot replaces it; the viewer and host paths are unaffected.
   */
  private deliverListenerSnapshot(
    listenerWs: WebSocket,
    att: ActiveAttachment,
    bytes: Uint8Array,
  ): void {
    if (bufferedAmountOf(listenerWs) >= LISTENER_SNAPSHOT_BUFFER_LIMIT) {
      this.logger.debug("listener_snapshot_dropped", {
        sessionId: this.sessionId,
        clientId: att.clientId,
        bytes: bytes.byteLength,
        reason: "buffer_high",
      });
      return;
    }
    if (!this.sendBinary(listenerWs, bytes)) {
      this.logger.debug("listener_snapshot_dropped", {
        sessionId: this.sessionId,
        clientId: att.clientId,
        bytes: bytes.byteLength,
        reason: "send_failed",
      });
      return;
    }
    this.logger.debug("listener_snapshot_sent", {
      sessionId: this.sessionId,
      clientId: att.clientId,
      bytes: bytes.byteLength,
    });
  }

  private closeSlowConsumer(viewerWs: WebSocket, att: ActiveAttachment): void {
    this.logger.warn("slow_consumer", {
      sessionId: this.sessionId,
      clientId: att.clientId,
      unackedBytes: att.unackedBytes,
    });
    this.closeWithError(
      viewerWs,
      "slow_consumer",
      "viewer is not acknowledging terminal output",
      CLOSE_CODES.slowConsumer,
    );
  }

  /**
   * Account one relay-delivered terminal frame against the session byte cap.
   *
   * Returns `true` when the cap was reached and the session has been closed;
   * the caller must not route the frame. With the cap disabled (default `0`)
   * no counter is kept at all.
   */
  private async recordRelayBytes(bytes: number): Promise<boolean> {
    const limit = sessionMaxBytes(this.env);
    if (limit <= 0) {
      return false;
    }
    this.loadRelayBytes();
    this.sessionBytes += bytes;
    this.sessionBytesUnflushed += bytes;
    if (this.sessionBytesUnflushed >= BYTES_FLUSH_THRESHOLD) {
      this.flushRelayBytes();
    }
    if (this.sessionBytes >= limit) {
      await this.closeForQuota("bytes");
      return true;
    }
    return false;
  }

  /** Adopt the persisted byte total once per DO instance (or per new session). */
  private loadRelayBytes(): void {
    if (this.sessionBytesLoaded) {
      return;
    }
    const meta = this.purged ? null : loadSessionMetadata(this.ctx.storage.sql);
    this.sessionBytes = meta?.relayBytes ?? 0;
    this.sessionBytesUnflushed = 0;
    this.sessionBytesLoaded = true;
  }

  /** Persist the in-memory byte total; called at most once per flush window. */
  private flushRelayBytes(): void {
    if (this.sessionBytesUnflushed === 0) {
      return;
    }
    setRelayBytes(this.ctx.storage.sql, this.sessionBytes);
    this.sessionBytesUnflushed = 0;
  }

  /**
   * Slide the per-session inbound message window and report whether it
   * exceeded `TOKIMEKI_SESSION_MAX_MESSAGES_PER_SECOND`.
   *
   * The window is per DO instance; hibernation/eviction resets it. The limit
   * protects against short bursts, not exact billing.
   */
  private exceedsMessageRate(now: number): boolean {
    const limit = sessionMaxMessagesPerSecond(this.env);
    if (limit <= 0) {
      return false;
    }
    const cutoff = now - MESSAGE_RATE_WINDOW_MS;
    while (this.messageTimestamps.length > 0 && (this.messageTimestamps[0] ?? 0) < cutoff) {
      this.messageTimestamps.shift();
    }
    this.messageTimestamps.push(now);
    return this.messageTimestamps.length > limit;
  }

  /**
   * Close the whole session for a hard-quota breach.
   *
   * Reuses the existing `session_full`/4002 capacity semantics (no new wire
   * error code) and deletes the session state. The shared PTY is never paused;
   * the host sees the same explicit close as every other socket.
   */
  private async closeForQuota(kind: "bytes" | "rate"): Promise<void> {
    if (this.purged) {
      return;
    }
    this.flushRelayBytes();
    const meta = loadSessionMetadata(this.ctx.storage.sql);
    const limit =
      kind === "bytes" ? sessionMaxBytes(this.env) : sessionMaxMessagesPerSecond(this.env);
    const observed = kind === "bytes" ? this.sessionBytes : this.messageTimestamps.length;
    const sockets = this.ctx.getWebSockets();
    this.purged = true;
    this.logger.warn("quota_exceeded", {
      sessionId: this.sessionId,
      socketCount: sockets.length,
      kind,
      limit,
      observed,
      ...(meta?.namespaceId == null ? {} : { namespace: meta.namespaceId }),
    });
    for (const socket of sockets) {
      this.closeWithError(
        socket,
        "session_full",
        "session quota exceeded",
        CLOSE_CODES.sessionFull,
        undefined,
        false,
      );
    }
    this.schemaReady = false;
    await this.ctx.storage.deleteAll();
  }

  /**
   * Purge an expired session and close every socket with the existing
   * `host_exited`/4004 lifecycle semantics (no new wire error code). Used by
   * the absolute TTL, idle TTL, and host-offline TTL paths.
   */
  private async purgeSession(
    reason: "absolute_ttl" | "idle_ttl" | "host_offline_ttl",
  ): Promise<void> {
    if (this.purged) {
      return;
    }
    this.purged = true;
    this.logger.info("session_expired", {
      sessionId: this.sessionId,
      reason,
    });
    const message =
      reason === "absolute_ttl"
        ? "session reached its absolute lifetime limit"
        : reason === "idle_ttl"
          ? "session expired after inactivity"
          : "session expired after the host stayed offline past its TTL";
    for (const socket of this.ctx.getWebSockets()) {
      this.closeWithError(socket, "host_exited", message, CLOSE_CODES.hostExited, undefined, false);
    }
    this.schemaReady = false;
    await this.ctx.storage.deleteAll();
  }

  private notifyHostFlow(clientId: string, kind: "pause" | "resume"): void {
    const host = this.findHost();
    if (host === null) {
      return;
    }
    this.sendControl(host.ws, {
      v: PROTOCOL_VERSION,
      type: kind,
      clientId,
    });
  }

  /**
   * Retire an active socket that is still `OPEN` from the DO's perspective but
   * has been replaced by a newer authenticated connection using the same client
   * id. This covers a stale host socket (typically a 1006 the DO has not
   * observed yet) and a viewer that squatted the host's client id while the
   * host was offline.
   *
   * The attachment is marked first so the socket is excluded from routing and
   * client counts before its close event is observed; that event must not
   * broadcast `peer-left` or `host online:false` for the replacement.
   */
  private supersedeSocket(
    existing: ActiveSocket,
    reason: "host-reconnect" | "host-takeover",
  ): void {
    this.saveAttachment(existing.ws, { ...existing.att, superseded: true });
    this.closeWithError(
      existing.ws,
      "duplicate_client_id",
      "connection was replaced by a newer authenticated connection",
      CLOSE_CODES.invalidMessage,
      undefined,
      false,
    );
    this.logger.info("socket_superseded", {
      sessionId: this.sessionId,
      clientId: existing.att.clientId,
      role: existing.att.role,
      reason,
    });
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const resizeTimer = this.resizeTimers.get(ws);
    if (resizeTimer !== undefined) {
      clearTimeout(resizeTimer);
      this.resizeTimers.delete(ws);
    }
    const attachment = readAttachment(ws);
    if (attachment === null || attachment.kind !== "active") {
      if (!this.purged) {
        await this.rescheduleAlarm();
      }
      return;
    }
    if (attachment.superseded === true) {
      // A replacement host already owns routing; a stale close must not look
      // like the host went offline to viewers.
      this.logger.info("superseded_socket_closed", {
        sessionId: this.sessionId,
        clientId: attachment.clientId,
        closeCode: code,
      });
      return;
    }
    const now = Date.now();
    const others = this.activeSockets().filter((candidate) => candidate.ws !== ws);
    if (this.purged) {
      return;
    }
    const hostStillOnline = this.activeSockets().some(
      (candidate) => candidate.ws !== ws && candidate.att.role === "host",
    );
    if (attachment.role === "host") {
      if (!hostStillOnline) {
        const meta = loadSessionMetadata(this.ctx.storage.sql);
        if (meta !== null) {
          setHostOfflineDeadline(this.ctx.storage.sql, now + meta.sessionTtlSeconds * 1000);
        }
      }
    } else if (attachment.role === "viewer" && attachment.paused) {
      this.notifyHostFlow(attachment.clientId, "resume");
    }
    this.broadcastTo(others, {
      v: PROTOCOL_VERSION,
      type: "peer-left",
      clientId: attachment.clientId,
    });
    if (attachment.role === "host" && !hostStillOnline) {
      this.broadcastTo(others, {
        v: PROTOCOL_VERSION,
        type: "host",
        online: false,
      });
    }
    this.broadcastTo(others, {
      v: PROTOCOL_VERSION,
      type: "presence",
      clients: this.currentClients(ws),
    });
    this.logger.info("connection_closed", {
      sessionId: this.sessionId,
      clientId: attachment.clientId,
      role: attachment.role,
      closeCode: code,
    });
    await this.rescheduleAlarm();
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const attachment = readAttachment(ws);
    this.logger.warn("websocket_error", {
      sessionId: this.sessionId,
      clientId: attachment?.kind === "active" ? attachment.clientId : null,
      role: attachment === null ? null : attachment.role,
    });
    try {
      ws.close(CLOSE_CODES.internalError, "internal_error");
    } catch {
      // The socket may already be closed.
    }
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = readAttachment(ws);
      if (attachment !== null && attachment.kind === "pending" && attachment.deadline <= now) {
        this.closeWithError(
          ws,
          "unauthorized",
          "hello was not received before the authentication deadline",
          CLOSE_CODES.unauthorized,
        );
      }
    }

    const meta = this.purged ? null : loadSessionMetadata(this.ctx.storage.sql);
    if (meta !== null) {
      // Flush the approximate byte meter before evaluating expiry so a restart
      // after purging does not resurrect a stale (lower) persisted total.
      if (sessionMaxBytes(this.env) > 0) {
        this.loadRelayBytes();
        this.flushRelayBytes();
      }
      // Priority: absolute TTL -> idle TTL -> host-offline TTL. A persisted
      // absolute deadline is ignored while the cap is disabled so the env
      // switch is a real rollback for pre-existing sessions too.
      if (
        sessionMaxTtlSeconds(this.env) > 0 &&
        meta.absoluteDeadline !== null &&
        meta.absoluteDeadline <= now
      ) {
        await this.purgeSession("absolute_ttl");
        return;
      }
      const idleTtl = sessionIdleTtlSeconds(this.env);
      if (idleTtl > 0 && meta.lastActivityAt + idleTtl * 1000 <= now) {
        await this.purgeSession("idle_ttl");
        return;
      }
      if (
        !this.isHostOnline() &&
        meta.hostOfflineDeadline !== null &&
        meta.hostOfflineDeadline <= now
      ) {
        await this.purgeSession("host_offline_ttl");
        return;
      }
    }

    await this.rescheduleAlarm();
  }

  private async rescheduleAlarm(): Promise<void> {
    const now = Date.now();
    const deadlines: number[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = readAttachment(ws);
      if (
        ws.readyState === WebSocket.OPEN &&
        attachment !== null &&
        attachment.kind === "pending"
      ) {
        deadlines.push(attachment.deadline);
      }
    }
    const meta = this.purged ? null : loadSessionMetadata(this.ctx.storage.sql);
    if (meta !== null) {
      // Absolute and idle deadlines apply even while the host is online, but
      // only while their env switches are enabled (rollback = turn them off).
      if (sessionMaxTtlSeconds(this.env) > 0 && meta.absoluteDeadline !== null) {
        deadlines.push(meta.absoluteDeadline);
      }
      const idleTtl = sessionIdleTtlSeconds(this.env);
      if (idleTtl > 0) {
        deadlines.push(meta.lastActivityAt + idleTtl * 1000);
      }
      if (!this.isHostOnline() && meta.hostOfflineDeadline !== null) {
        deadlines.push(meta.hostOfflineDeadline);
      }
    }
    const leaseExpiry = this.purged ? null : nextAgentLeaseExpiry(this.ctx.storage.sql, now);
    if (leaseExpiry !== null) {
      deadlines.push(leaseExpiry);
    }
    if (deadlines.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const next = Math.min(...deadlines);
    await this.ctx.storage.setAlarm(Math.max(next, now + 1));
  }

  private activeSockets(): ActiveSocket[] {
    const sockets: ActiveSocket[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      const att = readAttachment(ws);
      if (att !== null && att.kind === "active" && att.superseded !== true) {
        sockets.push({ ws, att });
      }
    }
    return sockets;
  }

  private findActive(clientId: string): ActiveSocket | null {
    for (const socket of this.activeSockets()) {
      if (socket.att.clientId === clientId) {
        return socket;
      }
    }
    return null;
  }

  private findHost(): ActiveSocket | null {
    for (const socket of this.activeSockets()) {
      if (socket.att.role === "host") {
        return socket;
      }
    }
    return null;
  }

  private isHostOnline(): boolean {
    return this.findHost() !== null;
  }

  private currentClients(exclude?: WebSocket): ClientInfo[] {
    return this.activeSockets()
      .filter((socket) => socket.ws !== exclude)
      .map(({ att }) => ({
        clientId: att.clientId,
        role: att.role,
        connectedAt: att.connectedAt,
        lastSeenAt: att.lastSeenAt,
        transport: { mode: att.transportMode, state: att.transportState },
        ...(att.client === undefined ? {} : { client: att.client }),
        ...(att.capabilities === undefined ? {} : { capabilities: att.capabilities }),
      }));
  }

  private broadcastTo(sockets: readonly ActiveSocket[], message: unknown): void {
    for (const socket of sockets) {
      this.sendControl(socket.ws, message);
    }
  }

  private touch(ws: WebSocket, att: ActiveAttachment, now: number): void {
    att.lastSeenAt = now;
    this.saveAttachment(ws, att);
    if (this.purged) {
      return;
    }
    updateLastActivity(this.ctx.storage.sql, now);
    // Rescheduling on every message would be one SQLite write per frame; the
    // alarm re-reads `last_activity_at` when it fires, so a throttled trailing
    // reschedule is enough to move the idle deadline forward.
    if (
      sessionIdleTtlSeconds(this.env) > 0 &&
      now - this.lastIdleScheduleAt >= IDLE_RESCHEDULE_INTERVAL_MS
    ) {
      this.lastIdleScheduleAt = now;
      // Trailing reschedule only; the next alarm re-reads `last_activity_at`,
      // so a dropped scheduling attempt cannot expire an active session.
      void this.rescheduleAlarm().catch(() => undefined);
    }
  }

  /**
   * Optional per-session passcode (v1.2-D).
   *
   * The host stores a PBKDF2 verifier in `hello.passcode` on the first hello;
   * viewers/listeners submit the plaintext through the Worker-trusted
   * `X-Tokimeki-Passcode` header (kept only in the pending attachment until
   * hello). Five failures lock all viewer/listener verification for 30 s.
   * No passcode, verifier, or hash is ever logged.
   */
  private async serializePasscode<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.#passcodeQueue;
    let release!: () => void;
    this.#passcodeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async handlePasscode(
    ws: WebSocket,
    role: Role,
    hello: HelloMessage,
    pending: PendingAttachment,
    now: number,
  ): Promise<boolean> {
    let stored: ReturnType<typeof loadSessionPasscode>;
    try {
      stored = loadSessionPasscode(this.ctx.storage.sql);
    } catch {
      this.closeWithError(
        ws,
        "internal",
        "passcode store is unavailable",
        CLOSE_CODES.unauthorized,
      );
      return false;
    }
    if (role === "host") {
      const presented = hello.passcode;
      if (presented === undefined) {
        return true;
      }
      if (stored === null) {
        saveSessionPasscode(
          this.ctx.storage.sql,
          this.sessionId,
          {
            kdf: presented.kdf,
            salt: presented.salt,
            iterations: presented.iterations,
            hash: presented.hash,
          },
          now,
        );
        return true;
      }
      const sameParams =
        stored.kdf === presented.kdf &&
        stored.salt === presented.salt &&
        stored.iterations === presented.iterations;
      if (!sameParams || !(await constantTimeEqual(stored.hash, presented.hash))) {
        this.closeWithError(
          ws,
          "passcode_mismatch",
          "host passcode verifier does not match this session",
          CLOSE_CODES.unauthorized,
        );
        return false;
      }
      return true;
    }

    if (stored === null) {
      return true;
    }
    if (stored.lockedUntil !== null && stored.lockedUntil > now) {
      this.closeWithError(
        ws,
        "passcode_locked",
        "session passcode is locked; retry later",
        CLOSE_CODES.unauthorized,
      );
      return false;
    }
    const presented = pending.passcode;
    if (presented === null || presented.length === 0) {
      this.closeWithError(
        ws,
        "passcode_required",
        "this session requires a passcode",
        CLOSE_CODES.unauthorized,
      );
      return false;
    }
    if (
      presented.length < MIN_PASSCODE_INPUT_LENGTH ||
      presented.length > MAX_PASSCODE_INPUT_LENGTH
    ) {
      this.closeWithError(
        ws,
        "passcode_invalid",
        "session passcode is invalid",
        CLOSE_CODES.unauthorized,
      );
      return false;
    }
    const derived = await derivePasscodeHash(presented, stored.salt, stored.iterations);
    if (derived !== null && (await constantTimeEqual(derived, stored.hash))) {
      clearPasscodeFailures(this.ctx.storage.sql, this.sessionId, now);
      return true;
    }
    const failures = stored.failedAttempts + 1;
    if (failures >= MAX_PASSCODE_FAILURES) {
      recordPasscodeFailure(
        this.ctx.storage.sql,
        this.sessionId,
        0,
        now + PASSCODE_LOCKOUT_MS,
        now,
      );
      this.closeWithError(
        ws,
        "passcode_locked",
        "too many failed passcode attempts; retry later",
        CLOSE_CODES.unauthorized,
      );
      return false;
    }
    recordPasscodeFailure(this.ctx.storage.sql, this.sessionId, failures, null, now);
    this.closeWithError(
      ws,
      "passcode_invalid",
      "session passcode is invalid",
      CLOSE_CODES.unauthorized,
    );
    return false;
  }

  private saveAttachment(ws: WebSocket, attachment: SocketAttachment): void {
    try {
      ws.serializeAttachment(attachment);
    } catch {
      // Closed sockets cannot take attachments; the close handler will clean up.
    }
  }

  private sendControl(ws: WebSocket, message: unknown): boolean {
    if (ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      ws.send(encodeControlMessage(message));
      return true;
    } catch {
      return false;
    }
  }

  private sendBinary(ws: WebSocket, bytes: Uint8Array): boolean {
    if (ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      ws.send(bytes);
      return true;
    } catch {
      return false;
    }
  }

  private closeWithError(
    ws: WebSocket,
    code: ErrorCode,
    message: string,
    closeCode: number,
    requestId?: string,
    log = true,
  ): void {
    this.sendControl(ws, errorMessage(code, message, requestId));
    try {
      ws.close(closeCode, code);
    } catch {
      // The socket may already be closing.
    }
    if (log) {
      this.logger.info("connection_rejected", {
        sessionId: this.sessionId,
        code,
        closeCode,
      });
    }
  }
}
