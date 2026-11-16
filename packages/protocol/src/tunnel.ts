/**
 * v1.1 TUN profile record layout (`TUNNEL` 0x06 inner envelope).
 *
 * This module is deliberately free of cryptography: it validates and encodes
 * the fixed header plus the opaque AES-256-GCM ciphertext. The CLI owns the
 * Node `crypto` implementation; future Go/Rust clients can reproduce this
 * layout from the constants and golden vectors.
 *
 * Record layout:
 *
 * ```text
 * offset  size  field
 * 0       1     version (1)
 * 1       1     type (1=data, 2=ack, 3=fec, 4=ping)
 * 2       1     flags (bit0 = FEC parity)
 * 3       1     reserved (0)
 * 4       4     seq u32BE
 * 8       4     ackSeq u32BE
 * 12      4     ackBits u32BE
 * 16      12    nonce
 * 28      N     ciphertext + 16-byte GCM tag
 * ```
 *
 * AAD layout (all integers big-endian):
 *
 * ```text
 * [version u8][type u8][flags u8][direction u8]
 * [seq u32BE][ackSeq u32BE][ackBits u32BE][sessionId UTF-8]
 * ```
 */

import {
  MAX_SESSION_ID_LENGTH,
  TUNNEL_DIRECTIONS,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_NONCE_BYTES,
  TUNNEL_RECORD_HEADER_BYTES,
  TUNNEL_RECORD_TYPES,
  TUNNEL_RECORD_VERSION,
  TUNNEL_TAG_BYTES,
  type TunnelDirectionValue,
  type TunnelRecordType,
} from "./constants.js";
import { ProtocolFrameError } from "./frames.js";

const textEncoder = new TextEncoder();
const UINT32_MAX = 0xffff_ffff;

export interface TunnelRecordHeader {
  readonly version: number;
  readonly type: TunnelRecordType;
  readonly flags: number;
  readonly seq: number;
  readonly ackSeq: number;
  readonly ackBits: number;
  readonly nonce: Uint8Array;
}

export interface DecodedTunnelRecord {
  readonly header: TunnelRecordHeader;
  /** AEAD ciphertext including the 16-byte GCM tag. */
  readonly ciphertext: Uint8Array;
}

function invalid(message: string): ProtocolFrameError {
  return new ProtocolFrameError("invalid_frame", message);
}

function requireU32(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw invalid(`${label} must be a u32`);
  }
  return value;
}

function requireRecordType(type: number): TunnelRecordType {
  for (const [name, value] of Object.entries(TUNNEL_RECORD_TYPES)) {
    if (value === type) {
      return name as TunnelRecordType;
    }
  }
  throw invalid("unknown tunnel record type");
}

function requireDirection(direction: number): TunnelDirectionValue {
  if (
    direction !== TUNNEL_DIRECTIONS.hostToViewer &&
    direction !== TUNNEL_DIRECTIONS.viewerToHost
  ) {
    throw invalid("invalid tunnel direction");
  }
  return direction;
}

function validateHeader(header: TunnelRecordHeader): TunnelRecordHeader {
  if (header.version !== TUNNEL_RECORD_VERSION) {
    throw invalid(`unsupported tunnel record version ${String(header.version)}`);
  }
  requireRecordType(TUNNEL_RECORD_TYPES[header.type]);
  if (!Number.isInteger(header.flags) || header.flags < 0 || header.flags > 0xff) {
    throw invalid("tunnel flags must be a u8");
  }
  requireU32(header.seq, "tunnel seq");
  requireU32(header.ackSeq, "tunnel ackSeq");
  requireU32(header.ackBits, "tunnel ackBits");
  if (!(header.nonce instanceof Uint8Array) || header.nonce.byteLength !== TUNNEL_NONCE_BYTES) {
    throw invalid(`tunnel nonce must be ${TUNNEL_NONCE_BYTES} bytes`);
  }
  return header;
}

/**
 * Encode a tunnel record (header + nonce + ciphertext/tag).
 *
 * `ciphertext` must include the GCM tag and fit inside one DataChannel message
 * after the outer `TUNNEL` type byte.
 */
export function encodeTunnelRecord(header: TunnelRecordHeader, ciphertext: Uint8Array): Uint8Array {
  validateHeader(header);
  if (!(ciphertext instanceof Uint8Array)) {
    throw invalid("tunnel ciphertext must be a Uint8Array");
  }
  if (ciphertext.byteLength < TUNNEL_TAG_BYTES) {
    throw invalid("tunnel ciphertext is shorter than the GCM tag");
  }
  if (ciphertext.byteLength - TUNNEL_TAG_BYTES > TUNNEL_MAX_FRAME_BYTES) {
    throw invalid(`tunnel plaintext exceeds ${TUNNEL_MAX_FRAME_BYTES} bytes`);
  }

  const encoded = new Uint8Array(TUNNEL_RECORD_HEADER_BYTES + ciphertext.byteLength);
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  encoded[0] = header.version;
  encoded[1] = TUNNEL_RECORD_TYPES[header.type];
  encoded[2] = header.flags;
  encoded[3] = 0;
  view.setUint32(4, header.seq, false);
  view.setUint32(8, header.ackSeq, false);
  view.setUint32(12, header.ackBits, false);
  encoded.set(header.nonce, 16);
  encoded.set(ciphertext, TUNNEL_RECORD_HEADER_BYTES);
  return encoded;
}

/**
 * Decode and validate a tunnel record.
 *
 * Throws `ProtocolFrameError("invalid_frame")` for malformed metadata. The
 * ciphertext is returned untouched; AEAD authentication happens in the CLI.
 */
export function decodeTunnelRecord(record: Uint8Array): DecodedTunnelRecord {
  if (!(record instanceof Uint8Array)) {
    throw invalid("tunnel record must be a Uint8Array");
  }
  if (record.byteLength < TUNNEL_RECORD_HEADER_BYTES + TUNNEL_TAG_BYTES) {
    throw invalid("tunnel record is truncated");
  }
  const ciphertextBytes = record.byteLength - TUNNEL_RECORD_HEADER_BYTES;
  if (ciphertextBytes - TUNNEL_TAG_BYTES > TUNNEL_MAX_FRAME_BYTES) {
    throw invalid(`tunnel plaintext exceeds ${TUNNEL_MAX_FRAME_BYTES} bytes`);
  }
  const reserved = record[3];
  if (reserved !== 0) {
    throw invalid("tunnel reserved byte must be zero");
  }
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const header: TunnelRecordHeader = {
    version: record[0] ?? 0,
    type: requireRecordType(record[1] ?? 0),
    flags: record[2] ?? 0,
    seq: view.getUint32(4, false),
    ackSeq: view.getUint32(8, false),
    ackBits: view.getUint32(12, false),
    nonce: record.slice(16, 16 + TUNNEL_NONCE_BYTES),
  };
  validateHeader(header);
  return { header, ciphertext: record.slice(TUNNEL_RECORD_HEADER_BYTES) };
}

/**
 * Build the AEAD additional authenticated data for a tunnel record.
 *
 * Binding the direction stops a peer from reflecting its own record back, and
 * binding `sessionId` stops cross-session ciphertext substitution.
 */
export function encodeTunnelAad(
  header: TunnelRecordHeader,
  direction: TunnelDirectionValue,
  sessionId: string,
): Uint8Array {
  validateHeader(header);
  requireDirection(direction);
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw invalid("tunnel AAD session id must be non-empty");
  }
  const sessionBytes = textEncoder.encode(sessionId);
  if (sessionBytes.byteLength > MAX_SESSION_ID_LENGTH) {
    throw invalid("tunnel AAD session id is too long");
  }

  const aad = new Uint8Array(16 + sessionBytes.byteLength);
  const view = new DataView(aad.buffer, aad.byteOffset, aad.byteLength);
  aad[0] = header.version;
  aad[1] = TUNNEL_RECORD_TYPES[header.type];
  aad[2] = header.flags;
  aad[3] = direction;
  view.setUint32(4, header.seq, false);
  view.setUint32(8, header.ackSeq, false);
  view.setUint32(12, header.ackBits, false);
  aad.set(sessionBytes, 16);
  return aad;
}
