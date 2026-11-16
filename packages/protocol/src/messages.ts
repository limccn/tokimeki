import { z } from "zod";

import {
  ALL_ROLES,
  ERROR_CODES,
  ICE_PROVIDERS,
  ICE_TRANSPORT_POLICIES,
  isTerminalSizeWithinLimits,
  MAX_CONTROL_MESSAGE_BYTES,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_REQUEST_ID_LENGTH,
  MAX_SIGNAL_PAYLOAD_BYTES,
  MAX_TERMINAL_DIMENSION,
  PROTOCOL_VERSION,
  SIGNAL_KINDS,
  TRANSPORT_MODES,
  TRANSPORT_STATES,
} from "./constants.js";
import { zClientId, zSessionId } from "./ids.js";
import { zU64String } from "./u64.js";

const zV1 = z.literal(PROTOCOL_VERSION);
const textEncoder = new TextEncoder();

/**
 * Capability objects advertised in `hello` and echoed (as a negotiated
 * intersection) in `welcome`.
 *
 * Every object here is a loose object and every known field is optional on
 * purpose: a v1 relay must not reject a connection because a newer client
 * advertises a capability name, key, or value it does not understand. Unknown
 * capabilities are ignored, not negotiated.
 */
export const TunnelCapabilitySchema = z.looseObject({
  version: z.number().int().positive().optional(),
  /** Expected v1.1 values include `kcp` and `selective-repeat`. */
  arq: z.string().min(1).optional(),
  /** Expected v1.1 values include `xor` and `rs`. */
  fec: z.array(z.string().min(1)).optional(),
  /** Expected v1.1 value: `aes-256-gcm`. */
  crypto: z.string().min(1).optional(),
  maxFrameSize: z.number().int().positive().optional(),
});

export const ListenerCapabilitySchema = z.looseObject({
  /** Expected v1.1 values include `snapshot-only` and `safe-boundary`. */
  modes: z.array(z.string().min(1)).optional(),
});

export const PeerRelayCapabilitySchema = z.looseObject({
  version: z.number().int().positive().optional(),
  roles: z.array(z.string().min(1)).optional(),
});

export const SnapshotCapabilitySchema = z.looseObject({
  /** Expected values include `xterm-serialize` and `raw-ring`. */
  formats: z.array(z.string().min(1)).optional(),
  maxBytes: z.number().int().positive().optional(),
});

export const TransportsCapabilitySchema = z.looseObject({
  /** Expected v1 values: `p2p-direct`, `p2p-turn`, `relay`. */
  modes: z.array(z.string().min(1)).optional(),
  /**
   * v1.1 optional P2P fragmentation envelope. Values must match the protocol
   * constants; peers with a different version/limit are treated as unsupported.
   */
  fragmentation: z
    .looseObject({
      version: z.number().int().positive().optional(),
      maxFrameBytes: z.number().int().positive().optional(),
      maxMessageBytes: z.number().int().positive().optional(),
    })
    .optional(),
});

export const CapabilitiesSchema = z.looseObject({
  /** Capability schema generation, independent from the wire version. */
  protocolVersion: z.number().int().nonnegative().optional(),
  transports: TransportsCapabilitySchema.optional(),
  snapshot: SnapshotCapabilitySchema.optional(),
  /** Reserved for v1.1; ignored by v1. */
  tunnel: TunnelCapabilitySchema.optional(),
  /** Reserved for v1.1; ignored by v1. */
  listener: ListenerCapabilitySchema.optional(),
  /** Reserved for v1.1; ignored by v1. */
  peerRelay: PeerRelayCapabilitySchema.optional(),
});

/** TURN/STUN server entry handed to WebRTC clients. */
export const IceServerConfigSchema = z.looseObject({
  urls: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  username: z.string().optional(),
  credential: z.string().optional(),
});

/** Transport state attached to a connected client. */
export const ClientTransportSchema = z.looseObject({
  mode: z.enum(TRANSPORT_MODES),
  state: z.enum(TRANSPORT_STATES),
  /** Reserved for v1.1 (`host`, `peer:<id>`, `relay`). */
  via: z.string().min(1).max(80).optional(),
});

/** One connected client as reported by `welcome` / `presence`. */
export const ClientInfoSchema = z.looseObject({
  clientId: zClientId,
  role: z.enum(ALL_ROLES).optional(),
  /** Epoch milliseconds. */
  connectedAt: z.number().int().nonnegative().optional(),
  lastSeenAt: z.number().int().nonnegative().optional(),
  transport: ClientTransportSchema.optional(),
  capabilities: CapabilitiesSchema.optional(),
});

/**
 * Protocol-visible session metadata.
 *
 * `hostTokenHash` and other credentials intentionally stay inside the Session
 * Durable Object and are never part of this type.
 */
export const SessionMetaSchema = z.looseObject({
  id: zSessionId,
  /** Epoch milliseconds. */
  createdAt: z.number().int().nonnegative(),
  lastActivityAt: z.number().int().nonnegative().optional(),
  ttlSeconds: z.number().int().positive(),
  maxClients: z.number().int().positive().optional(),
  hostOnline: z.boolean().optional(),
});

const terminalDimension = z.number().int().min(1).max(MAX_TERMINAL_DIMENSION);

export const HelloMessageSchema = z
  .looseObject({
    v: zV1,
    type: z.literal("hello"),
    role: z.enum(ALL_ROLES),
    session: zSessionId,
    clientId: zClientId,
    protocolVersion: zV1.default(PROTOCOL_VERSION),
    capabilities: CapabilitiesSchema.default({}),
    cols: terminalDimension.optional(),
    rows: terminalDimension.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.cols !== undefined &&
      value.rows !== undefined &&
      !isTerminalSizeWithinLimits(value.cols, value.rows)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "terminal size exceeds the cell limit",
        path: ["cols"],
      });
    }
  });

export const WelcomeMessageSchema = z.looseObject({
  v: zV1,
  type: z.literal("welcome"),
  session: zSessionId,
  protocolVersion: zV1.default(PROTOCOL_VERSION),
  hostOnline: z.boolean(),
  clients: z.array(ClientInfoSchema).default([]),
  iceServers: z.array(IceServerConfigSchema).default([]),
  iceProvider: z.enum(ICE_PROVIDERS),
  /** Epoch milliseconds; `null` / absent when the provider has no expiry. */
  iceExpiresAt: z.number().int().nonnegative().nullable().optional(),
  transportPolicy: z.enum(ICE_TRANSPORT_POLICIES).default("all"),
  sessionTtlSeconds: z.number().int().positive(),
  capabilities: CapabilitiesSchema.optional(),
});

export const IceRefreshMessageSchema = z.looseObject({
  v: zV1,
  type: z.literal("ice-refresh"),
  /** Ask the relay to switch to a specific provider before issuing servers. */
  provider: z.enum(ICE_PROVIDERS).optional(),
});

export const IceMessageSchema = z.looseObject({
  v: zV1,
  type: z.literal("ice"),
  iceServers: z.array(IceServerConfigSchema),
  iceProvider: z.enum(ICE_PROVIDERS),
  iceExpiresAt: z.number().int().nonnegative().nullable().optional(),
});

export const PeerJoinedMessageSchema = z.looseObject({
  v: zV1,
  type: z.literal("peer-joined"),
  clientId: zClientId,
  capabilities: CapabilitiesSchema.default({}),
});

export const PeerLeftMessageSchema = z.looseObject({
  v: zV1,
  type: z.literal("peer-left"),
  clientId: zClientId,
});

export const SignalMessageSchema = z.looseObject({
  v: zV1,
  type: z.literal("signal"),
  /** Destination client ID (host or viewer). */
  to: zClientId,
  /** Sender client ID, filled by the relay when forwarding. */
  from: zClientId,
  kind: z.enum(SIGNAL_KINDS),
  /** Opaque SDP / ICE candidate JSON forwarded without interpretation. */
  payload: z.json(),
});

export const TransportMessageSchema = z.looseObject({
  v: zV1,
  type: z.literal("transport"),
  clientId: zClientId,
  mode: z.enum(TRANSPORT_MODES),
  state: z.enum(TRANSPORT_STATES),
  reason: z.string().max(MAX_ERROR_MESSAGE_LENGTH).optional(),
  /** Reserved for v1.1 (`host`, `peer:<id>`, `relay`). */
  via: z.string().min(1).max(80).optional(),
});

export const ResizeMessageSchema = z
  .looseObject({
    v: zV1,
    type: z.literal("resize"),
    clientId: zClientId,
    cols: terminalDimension,
    rows: terminalDimension,
  })
  .refine((value) => isTerminalSizeWithinLimits(value.cols, value.rows), {
    message: "terminal size exceeds the cell limit",
    path: ["cols"],
  });

export const ResyncMessageSchema = z.looseObject({
  v: zV1,
  type: z.literal("resync"),
  /** Set by the relay when forwarding a viewer's request to the host. */
  clientId: zClientId.optional(),
  /** Last output seq the viewer already rendered; absent means "unknown". */
  fromSeq: zU64String.optional(),
});

export const AckMessageSchema = z.looseObject({
  v: zV1,
  type: z.literal("ack"),
  seq: zU64String,
});

export const PauseMessageSchema = z.looseObject({
  v: zV1,
  type: z.literal("pause"),
  clientId: zClientId,
});

export const ResumeMessageSchema = z.looseObject({
  v: zV1,
  type: z.literal("resume"),
  clientId: zClientId,
});

export const HostMessageSchema = z.looseObject({
  v: zV1,
  type: z.literal("host"),
  online: z.boolean(),
});

export const PresenceMessageSchema = z.looseObject({
  v: zV1,
  type: z.literal("presence"),
  clients: z.array(ClientInfoSchema).default([]),
});

export const PingMessageSchema = z.looseObject({
  v: zV1,
  type: z.literal("ping"),
  /** Optional application-level heartbeat timestamp, epoch milliseconds. */
  ts: z.number().int().nonnegative().optional(),
});

export const PongMessageSchema = z.looseObject({
  v: zV1,
  type: z.literal("pong"),
  ts: z.number().int().nonnegative().optional(),
});

export const ErrorMessageSchema = z.looseObject({
  v: zV1,
  type: z.literal("error"),
  code: z.enum(ERROR_CODES),
  message: z.string().min(1).max(MAX_ERROR_MESSAGE_LENGTH),
  requestId: z.string().min(1).max(MAX_REQUEST_ID_LENGTH).optional(),
  retryable: z.boolean().optional(),
  details: z.json().optional(),
  /** Present when `code` is `host-exited`. */
  exitCode: z.number().int().nullable().optional(),
  /** Present when `code` is `host-exited`. */
  signal: z.string().nullable().optional(),
});

export const HostExitedMessageSchema = z.looseObject({
  v: zV1,
  type: z.literal("host-exited"),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().nullable().optional(),
});

/** Reserved agent-coordination message types: `agent.<name>`. */
export const AGENT_MESSAGE_TYPE_PATTERN = /^agent\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Reserved `agent.*` envelope.
 *
 * The payload and every envelope field except `type` are optional so that a v1
 * relay can represent any future agent message, including ones it does not
 * implement, and answer with `error{code:"not_implemented"}`. See design §10.3
 * for the expected envelope (`type`, `requestId`, `protocolVersion`, `ts`,
 * `sessionId`, `payload`).
 */
export const AgentMessageSchema = z.looseObject({
  v: zV1.optional(),
  type: z
    .string()
    .regex(AGENT_MESSAGE_TYPE_PATTERN, "agent message type must match ^agent\\.[A-Za-z0-9._-]+$"),
  requestId: z.string().min(1).max(MAX_REQUEST_ID_LENGTH).optional(),
  protocolVersion: zV1.optional(),
  /** Epoch milliseconds. */
  ts: z.number().int().nonnegative().optional(),
  sessionId: zSessionId.optional(),
  payload: z.json().optional(),
});

/** Message `type` values implemented by protocol v1. */
export const KNOWN_CONTROL_MESSAGE_TYPES = [
  "hello",
  "welcome",
  "ice-refresh",
  "ice",
  "peer-joined",
  "peer-left",
  "signal",
  "transport",
  "resize",
  "resync",
  "ack",
  "pause",
  "resume",
  "host",
  "presence",
  "ping",
  "pong",
  "error",
  "host-exited",
] as const;
export type KnownControlMessageType = (typeof KNOWN_CONTROL_MESSAGE_TYPES)[number];

export const KnownControlMessageSchema = z.discriminatedUnion("type", [
  HelloMessageSchema,
  WelcomeMessageSchema,
  IceRefreshMessageSchema,
  IceMessageSchema,
  PeerJoinedMessageSchema,
  PeerLeftMessageSchema,
  SignalMessageSchema,
  TransportMessageSchema,
  ResizeMessageSchema,
  ResyncMessageSchema,
  AckMessageSchema,
  PauseMessageSchema,
  ResumeMessageSchema,
  HostMessageSchema,
  PresenceMessageSchema,
  PingMessageSchema,
  PongMessageSchema,
  ErrorMessageSchema,
  HostExitedMessageSchema,
]);

/**
 * Every control message accepted by protocol v1: the 19 known message types
 * plus the reserved `agent.*` envelope.
 */
export const ControlMessageSchema = z.union([KnownControlMessageSchema, AgentMessageSchema]);

export type TunnelCapability = z.infer<typeof TunnelCapabilitySchema>;
export type ListenerCapability = z.infer<typeof ListenerCapabilitySchema>;
export type PeerRelayCapability = z.infer<typeof PeerRelayCapabilitySchema>;
export type SnapshotCapability = z.infer<typeof SnapshotCapabilitySchema>;
export type TransportsCapability = z.infer<typeof TransportsCapabilitySchema>;
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type IceServerConfig = z.infer<typeof IceServerConfigSchema>;
export type ClientTransport = z.infer<typeof ClientTransportSchema>;
export type ClientInfo = z.infer<typeof ClientInfoSchema>;
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type WelcomeMessage = z.infer<typeof WelcomeMessageSchema>;
export type IceRefreshMessage = z.infer<typeof IceRefreshMessageSchema>;
export type IceMessage = z.infer<typeof IceMessageSchema>;
export type PeerJoinedMessage = z.infer<typeof PeerJoinedMessageSchema>;
export type PeerLeftMessage = z.infer<typeof PeerLeftMessageSchema>;
export type SignalMessage = z.infer<typeof SignalMessageSchema>;
export type TransportMessage = z.infer<typeof TransportMessageSchema>;
export type ResizeMessage = z.infer<typeof ResizeMessageSchema>;
export type ResyncMessage = z.infer<typeof ResyncMessageSchema>;
export type AckMessage = z.infer<typeof AckMessageSchema>;
export type PauseMessage = z.infer<typeof PauseMessageSchema>;
export type ResumeMessage = z.infer<typeof ResumeMessageSchema>;
export type HostMessage = z.infer<typeof HostMessageSchema>;
export type PresenceMessage = z.infer<typeof PresenceMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;
export type PongMessage = z.infer<typeof PongMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type HostExitedMessage = z.infer<typeof HostExitedMessageSchema>;
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
export type KnownControlMessage = z.infer<typeof KnownControlMessageSchema>;
export type ControlMessage = z.infer<typeof ControlMessageSchema>;

export const PROTOCOL_MESSAGE_ERROR_CODES = ["invalid_message", "unsupported_version"] as const;
export type ProtocolMessageErrorCode = (typeof PROTOCOL_MESSAGE_ERROR_CODES)[number];

/** Raised when a control message cannot be parsed or encoded. */
export class ProtocolMessageError extends Error {
  override readonly name = "ProtocolMessageError";

  constructor(
    readonly code: ProtocolMessageErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new ProtocolMessageError("invalid_message", "control message is not valid JSON");
  }
}

function checkVersionEnvelope(value: Record<string, unknown>): void {
  if (value.v !== undefined && value.v !== PROTOCOL_VERSION) {
    throw new ProtocolMessageError(
      "unsupported_version",
      `unsupported protocol version ${JSON.stringify(value.v)}; expected ${PROTOCOL_VERSION}`,
    );
  }
  const type = value.type;
  const carriesProtocolVersion =
    type === "hello" || (typeof type === "string" && type.startsWith("agent."));
  if (
    carriesProtocolVersion &&
    value.protocolVersion !== undefined &&
    value.protocolVersion !== PROTOCOL_VERSION
  ) {
    throw new ProtocolMessageError(
      "unsupported_version",
      `unsupported hello/agent protocolVersion ${JSON.stringify(value.protocolVersion)}; ` +
        `expected ${PROTOCOL_VERSION}`,
    );
  }
}

/**
 * Validate an incoming control message.
 *
 * Accepts either a raw JSON string (WebSocket text frame) or an already
 * decoded value. Throws `ProtocolMessageError` with `unsupported_version` for
 * a mismatched `v`/`protocolVersion`, and `invalid_message` for malformed JSON
 * or any schema violation.
 */
export function parseControlMessage(input: unknown): ControlMessage {
  if (typeof input === "string") {
    // Reject oversized frames before JSON.parse/zod so a peer cannot force
    // large allocations or deep recursion with a single text frame.
    if (
      input.length > MAX_CONTROL_MESSAGE_BYTES ||
      textEncoder.encode(input).byteLength > MAX_CONTROL_MESSAGE_BYTES
    ) {
      throw new ProtocolMessageError("invalid_message", "control message is too large");
    }
  }
  const decoded = typeof input === "string" ? decodeJson(input) : input;
  if (!isPlainObject(decoded)) {
    throw new ProtocolMessageError("invalid_message", "control message must be a JSON object");
  }
  checkVersionEnvelope(decoded);

  const type = decoded.type;
  if (
    typeof type === "string" &&
    !AGENT_MESSAGE_TYPE_PATTERN.test(type) &&
    !(KNOWN_CONTROL_MESSAGE_TYPES as readonly string[]).includes(type)
  ) {
    throw new ProtocolMessageError("invalid_message", `unknown control message type ${type}`);
  }

  // zod's recursive `z.json()` can exhaust the stack on deeply nested input.
  // Convert that and any other unexpected parser failure into a protocol error.
  const result = (() => {
    try {
      return ControlMessageSchema.safeParse(decoded);
    } catch {
      throw new ProtocolMessageError("invalid_message", "control message is too deeply nested");
    }
  })();
  if (!result.success) {
    throw new ProtocolMessageError("invalid_message", formatZodIssues(result.error));
  }
  if (result.data.type === "signal") {
    let payloadJson: string | undefined;
    try {
      payloadJson = JSON.stringify(result.data.payload);
    } catch {
      throw new ProtocolMessageError("invalid_message", "signal payload is not JSON serializable");
    }
    if (payloadJson === undefined) {
      throw new ProtocolMessageError("invalid_message", "signal payload is not JSON serializable");
    }
    if (textEncoder.encode(payloadJson).byteLength > MAX_SIGNAL_PAYLOAD_BYTES) {
      throw new ProtocolMessageError("invalid_message", "signal payload is too large");
    }
  }
  return result.data;
}

/** Result of `safeParseControlMessage`. */
export type ControlMessageParseResult =
  | { readonly success: true; readonly data: ControlMessage }
  | { readonly success: false; readonly error: ProtocolMessageError };

/** Non-throwing variant of `parseControlMessage`. */
export function safeParseControlMessage(input: unknown): ControlMessageParseResult {
  try {
    return { success: true, data: parseControlMessage(input) };
  } catch (error) {
    if (error instanceof ProtocolMessageError) {
      return { success: false, error };
    }
    // Parsing must never throw to relay/CLI callers; map unexpected runtime
    // failures (for example a stack overflow) to a protocol error.
    return {
      success: false,
      error: new ProtocolMessageError("invalid_message", "control message could not be parsed"),
    };
  }
}

/**
 * Validate and serialize a control message.
 *
 * Validation first means canonical defaults and u64 decimal strings are always
 * emitted, even when the caller passes JS numbers for `seq`. JSON
 * serialization failures (for example a `BigInt` smuggled through `details`)
 * are surfaced as `invalid_message`.
 */
export function encodeControlMessage(input: unknown): string {
  const message = parseControlMessage(input);
  try {
    return JSON.stringify(message);
  } catch {
    throw new ProtocolMessageError("invalid_message", "control message is not JSON serializable");
  }
}

/** True when a parsed message belongs to the reserved `agent.*` namespace. */
export function isAgentMessage(message: ControlMessage): message is AgentMessage {
  return message.type.startsWith("agent.");
}

export interface NotImplementedReplyOptions {
  /** Agent `requestId` to echo, when present. */
  readonly requestId?: string;
  /** Human-readable detail appended to the default message. */
  readonly detail?: string;
}

/**
 * Build the canonical `not_implemented` error a v1 relay returns for reserved
 * agent messages, reserved roles (`listener`), and reserved features.
 */
export function createNotImplementedErrorMessage(
  options: NotImplementedReplyOptions = {},
): ErrorMessage {
  const base = "feature is not implemented in protocol v1";
  const reply: ErrorMessage = {
    v: PROTOCOL_VERSION,
    type: "error",
    code: "not_implemented",
    message: options.detail === undefined ? base : `${base}: ${options.detail}`,
    retryable: false,
  };
  if (options.requestId !== undefined) {
    reply.requestId = options.requestId;
  }
  return reply;
}
