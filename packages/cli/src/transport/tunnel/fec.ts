/**
 * XOR forward error correction for the TUN profile (v1.1 F1.1).
 *
 * Data records are grouped in order (up to eight). When a group is full the
 * sender emits one AEAD `fec` parity record; the receiver can rebuild exactly
 * one missing data record from it. Lost parity, multiple losses, or pruned
 * state simply stay on the ARQ path — FEC is supplementary and never changes
 * correctness.
 *
 * FEC plaintext layout (inside an encrypted `fec` record):
 *
 * ```text
 * [startSeq u32BE][count u8][reserved u8]
 * [length u16BE * count]
 * [parity bytes: max(lengths)]
 * ```
 *
 * Every parity byte is the XOR of the group plaintexts zero-padded to the
 * group's maximum length. The parity record itself is sealed with the same
 * key/AAD as data records, so recovery never bypasses authentication.
 */

import { TUNNEL_MAX_FRAME_BYTES } from "@limccn/tokimeki-protocol";

/** Maximum data records protected by one parity record. */
export const TUNNEL_FEC_GROUP_SIZE = 8;
/** Metadata for a full group: 4 + 1 + 1 + 2 * 8 bytes. */
export const TUNNEL_FEC_METADATA_MAX_BYTES = 6 + 2 * TUNNEL_FEC_GROUP_SIZE;
/**
 * Largest data frame whose parity still fits one tunnel record.
 *
 * `TUNNEL_MAX_FRAME_BYTES` is the plaintext budget of one `TUNNEL` record;
 * the parity record carries the metadata on top of the parity bytes.
 */
export const TUNNEL_FEC_DATA_FRAME_MAX_BYTES =
  TUNNEL_MAX_FRAME_BYTES - TUNNEL_FEC_METADATA_MAX_BYTES;
/** Largest terminal payload in one FEC-protected OUTPUT frame (9-byte header). */
export const TUNNEL_FEC_OUTPUT_PAYLOAD_MAX_BYTES = TUNNEL_FEC_DATA_FRAME_MAX_BYTES - 9;
/** Largest terminal payload in one FEC-protected INPUT frame (1-byte header). */
export const TUNNEL_FEC_INPUT_PAYLOAD_MAX_BYTES = TUNNEL_FEC_DATA_FRAME_MAX_BYTES - 1;

/** Bounded receiver cache defaults (records / bytes / age). */
export const TUNNEL_FEC_RECEIVE_RECORDS = 64;
export const TUNNEL_FEC_RECEIVE_BYTES = 1_048_576;
export const TUNNEL_FEC_RECEIVE_MAX_AGE_MS = 30_000;

const UINT32_MAX = 0xffff_ffff;

/** One XOR parity group: metadata plus the parity bytes. */
export interface XorFecGroup {
  readonly startSeq: number;
  readonly count: number;
  readonly lengths: readonly number[];
  readonly parity: Uint8Array;
}

export type XorFecDropReason = "parity_too_large" | "non_contiguous";

function isValidU32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= UINT32_MAX;
}

/** Validate one group description against the bounded wire layout. */
function isValidGroup(group: XorFecGroup, maxCount: number): boolean {
  if (!isValidU32(group.startSeq)) return false;
  if (!Number.isInteger(group.count) || group.count < 1 || group.count > maxCount) return false;
  if (group.startSeq > UINT32_MAX - (group.count - 1)) return false;
  if (!Array.isArray(group.lengths) || group.lengths.length !== group.count) return false;
  if (!(group.parity instanceof Uint8Array)) return false;
  let maxLength = 0;
  for (const length of group.lengths) {
    if (!Number.isInteger(length) || length < 0 || length > TUNNEL_MAX_FRAME_BYTES) return false;
    if (length > maxLength) maxLength = length;
  }
  return group.parity.byteLength === maxLength;
}

/** Encode the FEC plaintext for one group (metadata followed by parity). */
export function encodeXorFecGroup(group: XorFecGroup): Uint8Array {
  if (!isValidGroup(group, TUNNEL_FEC_GROUP_SIZE)) {
    throw new Error("invalid XOR FEC group");
  }
  const metadataBytes = 6 + group.count * 2;
  const encoded = new Uint8Array(metadataBytes + group.parity.byteLength);
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  view.setUint32(0, group.startSeq, false);
  encoded[4] = group.count;
  encoded[5] = 0;
  group.lengths.forEach((length, index) => {
    view.setUint16(6 + index * 2, length, false);
  });
  encoded.set(group.parity, metadataBytes);
  return encoded;
}

/**
 * Decode FEC plaintext into a group description.
 *
 * Returns null for truncated/oversized/malformed metadata. The reserved byte
 * is ignored for forward compatibility; data lengths and the parity length
 * must agree exactly.
 */
export function decodeXorFecGroup(plaintext: Uint8Array): XorFecGroup | null {
  if (!(plaintext instanceof Uint8Array) || plaintext.byteLength < 6) return null;
  const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  const startSeq = view.getUint32(0, false);
  const count = plaintext[4] ?? 0;
  if (count < 1 || count > TUNNEL_FEC_GROUP_SIZE) return null;
  if (startSeq > UINT32_MAX - (count - 1)) return null;
  const metadataBytes = 6 + count * 2;
  if (plaintext.byteLength < metadataBytes) return null;

  const lengths: number[] = [];
  let maxLength = 0;
  for (let index = 0; index < count; index += 1) {
    const length = view.getUint16(6 + index * 2, false);
    if (length > TUNNEL_MAX_FRAME_BYTES) return null;
    if (length > maxLength) maxLength = length;
    lengths.push(length);
  }
  const parity = plaintext.subarray(metadataBytes);
  if (parity.byteLength !== maxLength) return null;
  return { startSeq, count, lengths, parity };
}

export interface XorFecSenderOptions {
  /** Records per group; clamped to 1..8 (default 8). */
  readonly groupSize?: number;
}

/**
 * Collects transmitted data plaintexts and emits one parity record per full
 * group.
 *
 * Groups are formed strictly in seq order: data records are only ever handed
 * here in increasing seq order by the ARQ sender, so at most one group is
 * pending and the buffer cannot grow without bound. Retransmissions repeat an
 * older seq and are ignored.
 */
export class XorFecSender {
  readonly #groupSize: number;
  #current: {
    readonly startSeq: number;
    entries: Array<{ seq: number; plaintext: Uint8Array }>;
  } | null = null;
  /** Highest seq handed to `add`; older retransmissions are duplicates. */
  #watermark = -1;
  #groupsSent = 0;
  #droppedGroups = 0;
  #lastDropReason: XorFecDropReason | null = null;

  constructor(options: XorFecSenderOptions = {}) {
    const requested = options.groupSize;
    this.#groupSize =
      requested === undefined || !Number.isInteger(requested) || requested < 1
        ? TUNNEL_FEC_GROUP_SIZE
        : Math.min(requested, TUNNEL_FEC_GROUP_SIZE);
  }

  get groupsSent(): number {
    return this.#groupsSent;
  }

  get droppedGroups(): number {
    return this.#droppedGroups;
  }

  get lastDropReason(): XorFecDropReason | null {
    return this.#lastDropReason;
  }

  get pendingRecords(): number {
    return this.#current?.entries.length ?? 0;
  }

  /**
   * Feed one successfully transmitted data record.
   *
   * Returns the encoded FEC plaintext when the group became full, otherwise
   * null. Duplicate/retransmitted seqs and incomplete groups emit nothing.
   */
  add(seq: number, plaintext: Uint8Array): Uint8Array | null {
    if (!isValidU32(seq) || !(plaintext instanceof Uint8Array)) return null;
    if (plaintext.byteLength > TUNNEL_MAX_FRAME_BYTES) return null;
    if (seq <= this.#watermark) return null;
    this.#watermark = seq;

    if (this.#current !== null && this.#current.startSeq + this.#current.entries.length !== seq) {
      // A seq gap would make the parity group non-contiguous; restart instead
      // of producing a group the receiver cannot index by seq range.
      this.#drop("non_contiguous");
      this.#current = null;
    }
    if (this.#current === null) {
      this.#current = { startSeq: seq, entries: [] };
    }
    this.#current.entries.push({ seq, plaintext: new Uint8Array(plaintext) });
    if (this.#current.entries.length < this.#groupSize) return null;

    const entries = this.#current.entries;
    this.#current = null;
    const startSeq = entries[0]?.seq;
    if (startSeq === undefined) return null;
    const lengths = entries.map((entry) => entry.plaintext.byteLength);
    let maxLength = 0;
    for (const length of lengths) {
      if (length > maxLength) maxLength = length;
    }
    if (maxLength > TUNNEL_FEC_DATA_FRAME_MAX_BYTES) {
      // The parity record would not fit one DataChannel message. ARQ remains
      // the recovery path for this group.
      this.#drop("parity_too_large");
      return null;
    }
    const parity = new Uint8Array(maxLength);
    for (const entry of entries) {
      for (let index = 0; index < entry.plaintext.byteLength; index += 1) {
        parity[index] = (parity[index] ?? 0) ^ (entry.plaintext[index] ?? 0);
      }
    }
    this.#groupsSent += 1;
    return encodeXorFecGroup({
      startSeq,
      count: entries.length,
      lengths,
      parity,
    });
  }

  reset(): void {
    this.#current = null;
    this.#watermark = -1;
  }

  #drop(reason: XorFecDropReason): void {
    this.#droppedGroups += 1;
    this.#lastDropReason = reason;
  }
}

export interface XorFecRecovery {
  readonly seq: number;
  readonly plaintext: Uint8Array;
}

export interface XorFecReceiverOptions {
  readonly maxRecords?: number;
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
  readonly maxGroupSize?: number;
  readonly now?: () => number;
}

/**
 * Bounded cache of recently received data plaintexts plus single-loss recovery.
 *
 * The cache only ever holds recent records (64 / 1 MiB / 30 s by default), so
 * a long-lived session cannot grow memory. Recovery requires exactly one
 * missing seq in the group and matching lengths for every present record.
 */
export class XorFecReceiver {
  readonly #maxRecords: number;
  readonly #maxBytes: number;
  readonly #maxAgeMs: number;
  readonly #maxGroupSize: number;
  readonly #now: () => number;
  readonly #records = new Map<number, { plaintext: Uint8Array; receivedAt: number }>();

  #bytes = 0;
  #recovered = 0;
  #rejected = 0;

  constructor(options: XorFecReceiverOptions = {}) {
    this.#maxRecords = options.maxRecords ?? TUNNEL_FEC_RECEIVE_RECORDS;
    this.#maxBytes = options.maxBytes ?? TUNNEL_FEC_RECEIVE_BYTES;
    this.#maxAgeMs = options.maxAgeMs ?? TUNNEL_FEC_RECEIVE_MAX_AGE_MS;
    this.#maxGroupSize = options.maxGroupSize ?? TUNNEL_FEC_GROUP_SIZE;
    this.#now = options.now ?? Date.now;
  }

  get cachedRecords(): number {
    return this.#records.size;
  }

  get cachedBytes(): number {
    return this.#bytes;
  }

  get recoveredCount(): number {
    return this.#recovered;
  }

  get rejectedParity(): number {
    return this.#rejected;
  }

  /** Store one authenticated data plaintext for possible recovery. */
  addData(seq: number, plaintext: Uint8Array): void {
    if (!isValidU32(seq) || !(plaintext instanceof Uint8Array)) return;
    if (plaintext.byteLength > TUNNEL_MAX_FRAME_BYTES) return;
    const now = this.#now();
    this.#prune(now);
    const existing = this.#records.get(seq);
    if (existing !== undefined) {
      existing.receivedAt = now;
      return;
    }
    this.#records.set(seq, { plaintext: new Uint8Array(plaintext), receivedAt: now });
    this.#bytes += plaintext.byteLength;
    this.#prune(now);
  }

  /**
   * Rebuild the single missing record in a parity group.
   *
   * Returns null when no record is missing, more than one is missing, or the
   * group metadata/lengths are inconsistent. Never throws on untrusted input.
   */
  tryRecover(group: XorFecGroup): XorFecRecovery | null {
    if (!isValidGroup(group, this.#maxGroupSize)) {
      this.#rejected += 1;
      return null;
    }
    const missing: number[] = [];
    let missingIndex = -1;
    for (let index = 0; index < group.count; index += 1) {
      const seq = group.startSeq + index;
      if (!this.#records.has(seq)) {
        missing.push(seq);
        missingIndex = index;
      }
    }
    if (missing.length !== 1) return null;

    const reconstructed = new Uint8Array(group.parity);
    for (let index = 0; index < group.count; index += 1) {
      if (index === missingIndex) continue;
      const record = this.#records.get(group.startSeq + index);
      if (record === undefined || record.plaintext.byteLength !== group.lengths[index]) {
        // A length mismatch means the parity cannot be attributed safely.
        this.#rejected += 1;
        return null;
      }
      for (let offset = 0; offset < record.plaintext.byteLength; offset += 1) {
        reconstructed[offset] = (reconstructed[offset] ?? 0) ^ (record.plaintext[offset] ?? 0);
      }
    }
    const missingSeq = missing[0];
    if (missingSeq === undefined) return null;
    this.#recovered += 1;
    const missingLength = group.lengths[missingIndex] ?? 0;
    return { seq: missingSeq, plaintext: reconstructed.subarray(0, missingLength) };
  }

  reset(): void {
    this.#records.clear();
    this.#bytes = 0;
  }

  #prune(now: number): void {
    for (const [seq, record] of this.#records) {
      const expired = now - record.receivedAt >= this.#maxAgeMs;
      const overRecords = this.#records.size > this.#maxRecords;
      const overBytes = this.#bytes > this.#maxBytes;
      if (!expired && !overRecords && !overBytes) break;
      this.#records.delete(seq);
      this.#bytes -= record.plaintext.byteLength;
    }
  }
}
