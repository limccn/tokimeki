/**
 * Language-neutral constants for the tokimeki wire protocol.
 *
 * Everything exported here is part of the wire contract: values are frozen as
 * strings or numbers so future Go/Rust implementations can mirror them without
 * depending on TypeScript-only constructs.
 */

/** Wire protocol version. Bumped only for breaking wire-format changes. */
export const PROTOCOL_VERSION = 1;

/**
 * Active connection roles.
 *
 * - `host` owns the PTY and is the only role allowed to send terminal output.
 * - `viewer` is a full shared-control client (input + output).
 * - `observer` watches control-plane / agent events but does not receive PTY data.
 * - `agent` is reserved for a future agent coordinator transport.
 * - `listener` is the v1.1 snapshot-only read-only role. It never sends input,
 *   resize, resync, ACKs, or signals, and only receives relay `SNAPSHOT_TO`
 *   frames. Pre-v1.1 relays reject it with `not_implemented`.
 */
export const ROLES = ["host", "viewer", "observer", "agent", "listener"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Roles reserved by a later protocol revision.
 *
 * Empty since v1.1 activated `listener`. Kept exported so implementations can
 * keep a single active/reserved split and future revisions can add entries.
 */
export const RESERVED_ROLES = [] as const;
export type ReservedRole = (typeof RESERVED_ROLES)[number];

/** Every role string accepted by the `hello` schema (active + reserved). */
export const ALL_ROLES = [...ROLES, ...RESERVED_ROLES] as const;
export type AnyRole = (typeof ALL_ROLES)[number];

/** True for roles the relay/CLI can route. */
export function isActiveRole(role: string): role is Role {
  return (ROLES as readonly string[]).includes(role);
}

/** True for roles reserved by a later protocol revision. */
export function isReservedRole(role: string): role is ReservedRole {
  return (RESERVED_ROLES as readonly string[]).includes(role);
}

/** Data transport carrying terminal bytes for a given peer. */
export const TRANSPORT_MODES = ["p2p-direct", "p2p-turn", "relay"] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];

/** Lifecycle of a transport selection attempt. */
export const TRANSPORT_STATES = ["selecting", "ready", "failed"] as const;
export type TransportState = (typeof TRANSPORT_STATES)[number];

/**
 * TURN/STUN provider that produced the `iceServers` handed to a client.
 *
 * `coturn` is the preferred self-hosted REST-credential provider, `static` is
 * a fixed coturn/static credential set, `cloudflare` is the Realtime TURN
 * fallback, and `stun` means "no TURN configured, direct attempts only".
 */
export const ICE_PROVIDERS = ["coturn", "static", "cloudflare", "stun"] as const;
export type IceProvider = (typeof ICE_PROVIDERS)[number];

/** Mirrors `TOKIMEKI_ICE_TRANSPORT_POLICY`. */
export const ICE_TRANSPORT_POLICIES = ["all", "relay"] as const;
export type IceTransportPolicy = (typeof ICE_TRANSPORT_POLICIES)[number];

/** Mirrors `TOKIMEKI_RESIZE_POLICY`. */
export const RESIZE_POLICIES = ["latest", "min", "pinned"] as const;
export type ResizePolicy = (typeof RESIZE_POLICIES)[number];

/** WebRTC signaling payload kinds forwarded opaquely by the relay. */
export const SIGNAL_KINDS = ["offer", "answer", "ice"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/**
 * Structured error codes carried by `error` control messages.
 *
 * New codes require a protocol version bump so that older clients never have
 * to guess at unknown semantics. The `agent.*` related codes are reserved for
 * the agent coordination namespace and are not emitted by the v1 terminal
 * runtime.
 */
export const ERROR_CODES = [
  // Authentication / routing.
  "unauthorized",
  "invalid_message",
  "unsupported_version",
  "invalid_session",
  "invalid_client_id",
  "duplicate_client_id",
  "invalid_role",
  // Frames.
  "invalid_frame",
  "unsupported_frame",
  "frame_too_large",
  "invalid_target",
  // Lifecycle.
  "not_implemented",
  "session_full",
  "host_offline",
  "host_exited",
  "slow_consumer",
  "transport_failed",
  "internal",
  // Agent coordination (reserved; emitted by future coordinator code).
  "invalid_request",
  "not_found",
  "lease_expired",
  "lease_mismatch",
  "task_terminal",
  "task_canceled",
  "capacity_exceeded",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * WebSocket close codes used by the relay and CLI.
 *
 * Codes 1000-1011 are standard; 4000-4999 are application defined. Keep the
 * values stable because clients switch on them after reconnect handling.
 */
export const CLOSE_CODES = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  messageTooBig: 1009,
  internalError: 1011,
  slowConsumer: 4000,
  unauthorized: 4001,
  sessionFull: 4002,
  invalidMessage: 4003,
  hostExited: 4004,
  notImplemented: 4005,
} as const;
export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES];

/** Maximum encoded binary frame size accepted by the v1 codecs (1 MiB). */
export const MAX_FRAME_BYTES = 1_048_576;

/** Maximum UTF-8 bytes for a raw control message (128 KiB). */
export const MAX_CONTROL_MESSAGE_BYTES = 131_072;

/** Maximum serialized bytes for a `signal.payload` (64 KiB). */
export const MAX_SIGNAL_PAYLOAD_BYTES = 65_536;

/**
 * Maximum payload for a single WebRTC DataChannel message.
 *
 * The host splits larger output into multiple frames of at most this size so
 * every frame stays inside the SCTP interop budget.
 */
export const MAX_DATACHANNEL_MESSAGE_BYTES = 16_384;

/**
 * Fixed header size of the v1.1 `FRAGMENT` frame (0x08).
 *
 * Layout: type(1) + messageId u32BE(4) + fragmentIndex u16BE(2) +
 * fragmentCount u16BE(2) + totalBytes u32BE(4) = 13 bytes.
 */
export const FRAGMENT_HEADER_BYTES = 13;

/** Largest chunk carried by one DataChannel fragment message. */
export const MAX_FRAGMENT_CHUNK_BYTES = MAX_DATACHANNEL_MESSAGE_BYTES - FRAGMENT_HEADER_BYTES;

/** Maximum fragments for a 1 MiB frame using canonical chunk sizes. */
export const MAX_FRAGMENT_COUNT = Math.ceil(MAX_FRAME_BYTES / MAX_FRAGMENT_CHUNK_BYTES);

/** Upper bound for terminal `cols` / `rows` values in control messages. */
export const MAX_TERMINAL_DIMENSION = 10_000;

/**
 * Maximum terminal cells (`cols * rows`) applied to a PTY / xterm mirror.
 *
 * ~49 ms of synchronous resize work at the validated xterm-headless probe;
 * larger sizes are rejected before they reach the host.
 */
export const MAX_TERMINAL_CELLS = 4_000_000;

/** True when a terminal size is positive and within the cell budget. */
export function isTerminalSizeWithinLimits(cols: number, rows: number): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols > 0 &&
    rows > 0 &&
    cols * rows <= MAX_TERMINAL_CELLS
  );
}

/** Upper bound for human-readable `error.message` values. */
export const MAX_ERROR_MESSAGE_LENGTH = 2_048;

/** Upper bound for agent `requestId` values. */
export const MAX_REQUEST_ID_LENGTH = 128;

/** Session IDs are ASCII, so the character limit equals the byte limit. */
export const MAX_SESSION_ID_LENGTH = 64;

/** Client IDs are ASCII, so the character limit equals the byte limit. */
export const MAX_CLIENT_ID_LENGTH = 64;

/** `SNAPSHOT_TO` / `TUNNEL_TO` target ID bounds (UTF-8 bytes). */
export const MIN_TARGET_ID_BYTES = 1;
export const MAX_TARGET_ID_BYTES = 64;
