/**
 * Bounds for ICE/SDP signaling strings that arrive from the relay.
 *
 * The relay's control-message limit (128 KiB) bounds the whole message; these
 * limits additionally bound individual fields and the queued candidate budget
 * before they reach libdatachannel.
 */

const textEncoder = new TextEncoder();

export const MAX_SIGNAL_CANDIDATE_BYTES = 8 * 1024;
export const MAX_SIGNAL_MID_BYTES = 256;
export const MAX_SIGNAL_SDP_BYTES = 64 * 1024;
export const MAX_PENDING_CANDIDATE_BYTES = 256 * 1024;

export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

/** Read a non-empty string field, or null when it is absent or oversized. */
export function readBoundedString(
  record: Record<string, unknown>,
  key: string,
  maxBytes: number,
): string | null {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return utf8ByteLength(value) <= maxBytes ? value : null;
}

/** ICE `mid` is optional; an oversized value is treated as absent. */
export function readBoundedMid(record: Record<string, unknown>): string {
  const value = record.mid;
  if (typeof value !== "string") {
    return "";
  }
  return utf8ByteLength(value) <= MAX_SIGNAL_MID_BYTES ? value : "";
}

export function candidateBudgetBytes(candidate: string, mid: string): number {
  return utf8ByteLength(candidate) + utf8ByteLength(mid);
}

export function canQueueCandidate(
  queuedCount: number,
  queuedBytes: number,
  bytes: number,
  maxCount: number,
  maxBytes = MAX_PENDING_CANDIDATE_BYTES,
): boolean {
  return queuedCount < maxCount && queuedBytes + bytes <= maxBytes;
}
