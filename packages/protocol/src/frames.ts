import { MAX_FRAME_BYTES, MAX_TARGET_ID_BYTES, MIN_TARGET_ID_BYTES } from "./constants.js";

/**
 * Binary frame type bytes shared by the WebSocket relay and WebRTC
 * DataChannels.
 *
 * `TUNNEL` and `TUNNEL_TO` are reserved for the v1.1 application-layer tunnel;
 * the v1 relay and CLI must decode them but answer with a structured
 * `not_implemented` error instead of forwarding them.
 */
export const FRAME_TYPES = {
  INPUT: 0x01,
  OUTPUT: 0x02,
  SNAPSHOT: 0x03,
  RESYNC_REQ: 0x04,
  SNAPSHOT_TO: 0x05,
  TUNNEL: 0x06,
  TUNNEL_TO: 0x07,
} as const;

export type FrameTypeCode = (typeof FRAME_TYPES)[keyof typeof FRAME_TYPES];

export const FRAME_TYPE_NAMES: Readonly<Record<FrameTypeCode, string>> = {
  [FRAME_TYPES.INPUT]: "INPUT",
  [FRAME_TYPES.OUTPUT]: "OUTPUT",
  [FRAME_TYPES.SNAPSHOT]: "SNAPSHOT",
  [FRAME_TYPES.RESYNC_REQ]: "RESYNC_REQ",
  [FRAME_TYPES.SNAPSHOT_TO]: "SNAPSHOT_TO",
  [FRAME_TYPES.TUNNEL]: "TUNNEL",
  [FRAME_TYPES.TUNNEL_TO]: "TUNNEL_TO",
};

/** Binary frame: viewer/attach -> host raw terminal input bytes. */
export interface InputFrame {
  readonly type: "input";
  readonly payload: Uint8Array;
}

/** Binary frame: host terminal output chunk with a session-wide output seq. */
export interface OutputFrame {
  readonly type: "output";
  readonly seq: number;
  readonly payload: Uint8Array;
}

/** Binary frame: full-screen ANSI snapshot sent directly over P2P. */
export interface SnapshotFrame {
  readonly type: "snapshot";
  readonly seq: number;
  readonly payload: Uint8Array;
}

/** Binary frame: viewer asks the host for a fresh snapshot. */
export interface ResyncRequestFrame {
  readonly type: "resync_req";
}

/** Binary frame: relay-directed snapshot for one specific viewer. */
export interface SnapshotToFrame {
  readonly type: "snapshot_to";
  readonly targetId: string;
  readonly seq: number;
  readonly payload: Uint8Array;
}

/** Reserved v1.1 frame: application-layer tunnel payload (broadcast form). */
export interface TunnelFrame {
  readonly type: "tunnel";
  readonly payload: Uint8Array;
}

/** Reserved v1.1 frame: application-layer tunnel payload for one target. */
export interface TunnelToFrame {
  readonly type: "tunnel_to";
  readonly targetId: string;
  readonly payload: Uint8Array;
}

export type BinaryFrame =
  | InputFrame
  | OutputFrame
  | SnapshotFrame
  | ResyncRequestFrame
  | SnapshotToFrame
  | TunnelFrame
  | TunnelToFrame;

/** Every frame the v1 relay/CLI is allowed to act on. */
export type V1Frame = Exclude<BinaryFrame, TunnelFrame | TunnelToFrame>;

/** Frames reserved for v1.1 (`TUNNEL` / `TUNNEL_TO`). */
export type ReservedFrame = TunnelFrame | TunnelToFrame;

export const FRAME_ERROR_CODES = [
  "frame_truncated",
  "frame_too_large",
  "unknown_frame_type",
  "invalid_target_id",
  "invalid_seq",
  "invalid_frame",
] as const;
export type FrameErrorCode = (typeof FRAME_ERROR_CODES)[number];

/** Error raised when a binary frame cannot be encoded or decoded. */
export class ProtocolFrameError extends Error {
  override readonly name = "ProtocolFrameError";

  constructor(
    readonly code: FrameErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function ensureUint8Array(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new ProtocolFrameError("invalid_frame", `${label} must be a Uint8Array`);
  }
  return value;
}

function ensureFrameSize(totalBytes: number): number {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    throw new ProtocolFrameError("invalid_frame", "frame size is not a valid byte length");
  }
  if (totalBytes > MAX_FRAME_BYTES) {
    throw new ProtocolFrameError(
      "frame_too_large",
      `frame exceeds the ${MAX_FRAME_BYTES}-byte protocol limit`,
    );
  }
  return totalBytes;
}

function allocateFrame(totalBytes: number): Uint8Array {
  return new Uint8Array(ensureFrameSize(totalBytes));
}

function dataViewOf(frame: Uint8Array): DataView {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
}

function writeU64BE(view: DataView, offset: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolFrameError(
      "invalid_seq",
      `sequence must be a non-negative safe integer, got ${String(value)}`,
    );
  }
  view.setBigUint64(offset, BigInt(value), false);
}

function readU64BE(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, false);
  if (value > MAX_SAFE_INTEGER_BIGINT) {
    throw new ProtocolFrameError(
      "invalid_seq",
      "sequence exceeds Number.MAX_SAFE_INTEGER and cannot be represented safely",
    );
  }
  return Number(value);
}

function encodeTargetId(targetId: string): Uint8Array {
  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new ProtocolFrameError("invalid_target_id", "target id must be a non-empty string");
  }
  const bytes = textEncoder.encode(targetId);
  if (bytes.byteLength < MIN_TARGET_ID_BYTES || bytes.byteLength > MAX_TARGET_ID_BYTES) {
    throw new ProtocolFrameError(
      "invalid_target_id",
      `target id must be ${MIN_TARGET_ID_BYTES}..${MAX_TARGET_ID_BYTES} UTF-8 bytes`,
    );
  }
  let roundTrip: string;
  try {
    roundTrip = textDecoder.decode(bytes);
  } catch {
    throw new ProtocolFrameError("invalid_target_id", "target id is not valid UTF-8");
  }
  if (roundTrip !== targetId) {
    throw new ProtocolFrameError("invalid_target_id", "target id is not valid Unicode");
  }
  return bytes;
}

interface DecodedTargetId {
  readonly targetId: string;
  readonly nextOffset: number;
}

function decodeTargetId(data: Uint8Array): DecodedTargetId {
  if (data.byteLength < 2) {
    throw new ProtocolFrameError("frame_truncated", "frame is missing the target id length");
  }
  const length = data[1];
  if (length === undefined || length < MIN_TARGET_ID_BYTES || length > MAX_TARGET_ID_BYTES) {
    throw new ProtocolFrameError(
      "invalid_target_id",
      `target id length must be ${MIN_TARGET_ID_BYTES}..${MAX_TARGET_ID_BYTES} bytes`,
    );
  }
  const end = 2 + length;
  if (data.byteLength < end) {
    throw new ProtocolFrameError("frame_truncated", "frame is truncated inside the target id");
  }
  let targetId: string;
  try {
    targetId = textDecoder.decode(data.subarray(2, end));
  } catch {
    throw new ProtocolFrameError("invalid_target_id", "target id is not valid UTF-8");
  }
  return { targetId, nextOffset: end };
}

/** True when `type` is one of the known 0x01..0x07 frame bytes. */
export function isKnownFrameType(type: number): type is FrameTypeCode {
  return Object.values(FRAME_TYPES).includes(type as FrameTypeCode);
}

/**
 * True for frames reserved by v1.1. v1 callers must answer `not_implemented`
 * for these types rather than forwarding their opaque payloads.
 */
export function isReservedFrameType(type: number): boolean {
  return type === FRAME_TYPES.TUNNEL || type === FRAME_TYPES.TUNNEL_TO;
}

/** True when a decoded frame belongs to the reserved v1.1 tunnel range. */
export function isReservedFrame(frame: BinaryFrame): frame is ReservedFrame {
  return frame.type === "tunnel" || frame.type === "tunnel_to";
}

/** Read the frame type byte, or `null` for an empty buffer. */
export function detectFrameType(data: Uint8Array): number | null {
  if (data.byteLength === 0) {
    return null;
  }
  return data[0] ?? null;
}

/** Encode a binary frame into its wire bytes. */
export function encodeFrame(frame: BinaryFrame): Uint8Array {
  switch (frame.type) {
    case "input": {
      const payload = ensureUint8Array(frame.payload, "input payload");
      const encoded = allocateFrame(1 + payload.byteLength);
      encoded[0] = FRAME_TYPES.INPUT;
      encoded.set(payload, 1);
      return encoded;
    }
    case "output": {
      const payload = ensureUint8Array(frame.payload, "output payload");
      const encoded = allocateFrame(9 + payload.byteLength);
      encoded[0] = FRAME_TYPES.OUTPUT;
      writeU64BE(dataViewOf(encoded), 1, frame.seq);
      encoded.set(payload, 9);
      return encoded;
    }
    case "snapshot": {
      const payload = ensureUint8Array(frame.payload, "snapshot payload");
      const encoded = allocateFrame(9 + payload.byteLength);
      encoded[0] = FRAME_TYPES.SNAPSHOT;
      writeU64BE(dataViewOf(encoded), 1, frame.seq);
      encoded.set(payload, 9);
      return encoded;
    }
    case "resync_req": {
      const encoded = allocateFrame(1);
      encoded[0] = FRAME_TYPES.RESYNC_REQ;
      return encoded;
    }
    case "snapshot_to": {
      const target = encodeTargetId(frame.targetId);
      const payload = ensureUint8Array(frame.payload, "snapshot_to payload");
      const encoded = allocateFrame(1 + 1 + target.byteLength + 8 + payload.byteLength);
      encoded[0] = FRAME_TYPES.SNAPSHOT_TO;
      encoded[1] = target.byteLength;
      encoded.set(target, 2);
      const seqOffset = 2 + target.byteLength;
      writeU64BE(dataViewOf(encoded), seqOffset, frame.seq);
      encoded.set(payload, seqOffset + 8);
      return encoded;
    }
    case "tunnel": {
      const payload = ensureUint8Array(frame.payload, "tunnel payload");
      const encoded = allocateFrame(1 + payload.byteLength);
      encoded[0] = FRAME_TYPES.TUNNEL;
      encoded.set(payload, 1);
      return encoded;
    }
    case "tunnel_to": {
      const target = encodeTargetId(frame.targetId);
      const payload = ensureUint8Array(frame.payload, "tunnel_to payload");
      const encoded = allocateFrame(1 + 1 + target.byteLength + payload.byteLength);
      encoded[0] = FRAME_TYPES.TUNNEL_TO;
      encoded[1] = target.byteLength;
      encoded.set(target, 2);
      encoded.set(payload, 2 + target.byteLength);
      return encoded;
    }
    default: {
      const exhaustive: never = frame;
      throw new ProtocolFrameError(
        "unknown_frame_type",
        `cannot encode unknown frame: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Decode wire bytes into a typed binary frame.
 *
 * Reserved `TUNNEL` / `TUNNEL_TO` frames decode successfully so that relays
 * and CLIs can emit `not_implemented`; use `isReservedFrame` to distinguish
 * them from frames the v1 runtime must act on.
 */
export function decodeFrame(data: Uint8Array): BinaryFrame {
  const bytes = ensureUint8Array(data, "frame");
  if (bytes.byteLength === 0) {
    throw new ProtocolFrameError("frame_truncated", "frame is empty");
  }
  if (bytes.byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolFrameError(
      "frame_too_large",
      `frame exceeds the ${MAX_FRAME_BYTES}-byte protocol limit`,
    );
  }

  const frameType = bytes[0];
  if (frameType === undefined) {
    throw new ProtocolFrameError("frame_truncated", "frame is empty");
  }

  switch (frameType) {
    case FRAME_TYPES.INPUT:
      return { type: "input", payload: bytes.slice(1) };
    case FRAME_TYPES.OUTPUT: {
      if (bytes.byteLength < 9) {
        throw new ProtocolFrameError("frame_truncated", "OUTPUT frame requires a u64 seq");
      }
      return {
        type: "output",
        seq: readU64BE(dataViewOf(bytes), 1),
        payload: bytes.slice(9),
      };
    }
    case FRAME_TYPES.SNAPSHOT: {
      if (bytes.byteLength < 9) {
        throw new ProtocolFrameError("frame_truncated", "SNAPSHOT frame requires a u64 seq");
      }
      return {
        type: "snapshot",
        seq: readU64BE(dataViewOf(bytes), 1),
        payload: bytes.slice(9),
      };
    }
    case FRAME_TYPES.RESYNC_REQ: {
      if (bytes.byteLength !== 1) {
        throw new ProtocolFrameError(
          "invalid_frame",
          "RESYNC_REQ must not carry a payload in protocol v1",
        );
      }
      return { type: "resync_req" };
    }
    case FRAME_TYPES.SNAPSHOT_TO: {
      const { targetId, nextOffset } = decodeTargetId(bytes);
      if (bytes.byteLength < nextOffset + 8) {
        throw new ProtocolFrameError(
          "frame_truncated",
          "SNAPSHOT_TO frame requires a u64 seq after the target id",
        );
      }
      return {
        type: "snapshot_to",
        targetId,
        seq: readU64BE(dataViewOf(bytes), nextOffset),
        payload: bytes.slice(nextOffset + 8),
      };
    }
    case FRAME_TYPES.TUNNEL:
      return { type: "tunnel", payload: bytes.slice(1) };
    case FRAME_TYPES.TUNNEL_TO: {
      const { targetId, nextOffset } = decodeTargetId(bytes);
      return { type: "tunnel_to", targetId, payload: bytes.slice(nextOffset) };
    }
    default:
      throw new ProtocolFrameError(
        "unknown_frame_type",
        `unknown frame type 0x${frameType.toString(16).padStart(2, "0")}`,
      );
  }
}
