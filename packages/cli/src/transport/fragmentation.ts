/**
 * Canonical v1.1 `FRAGMENT` (0x08) split/reassembly helpers.
 *
 * F0 only sends regular terminal output as <=16 KiB frames. Larger frames
 * (currently P2P snapshots) are split into `FRAGMENT` messages on the direct
 * DataChannel and reassembled before the existing `decodeFrame` path runs.
 *
 * The envelope is deliberately stateless: no ACKs, retransmission, or windows.
 * A missing fragment times out and the caller falls back to the relay snapshot
 * path; reliable selective-repeat transport is F1, not F0.
 */

import {
  decodeFrame,
  encodeFrame,
  FRAME_TYPES,
  MAX_DATACHANNEL_MESSAGE_BYTES,
  MAX_FRAGMENT_CHUNK_BYTES,
  MAX_FRAME_BYTES,
  ProtocolFrameError,
} from "@limccn/tokimeki-protocol";

import type { Logger } from "../logger.js";

export const FRAGMENT_REASSEMBLY_TIMEOUT_MS = 10_000;
export const MAX_CONCURRENT_REASSEMBLIES = 2;
export const MAX_FRAGMENT_REASSEMBLY_BYTES = 2 * MAX_FRAME_BYTES;

export interface FragmentTimers {
  setTimeout(handler: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}

export interface FragmentReassemblerOptions {
  readonly logger: Logger;
  readonly now?: () => number;
  readonly timers?: FragmentTimers;
}

const defaultTimers: FragmentTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

interface FragmentTransfer {
  readonly messageId: number;
  readonly fragmentCount: number;
  readonly totalBytes: number;
  readonly buffer: Uint8Array;
  readonly received: Uint8Array;
  receivedCount: number;
  readonly startedAt: number;
  timer: NodeJS.Timeout;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Split one complete frame into canonical `FRAGMENT` wire messages.
 *
 * Every chunk except the last is exactly `MAX_FRAGMENT_CHUNK_BYTES`; the last
 * carries the remainder. Throws `ProtocolFrameError` for invalid inputs so a
 * caller can fall back without sending a partial transfer.
 */
export function fragmentFrame(frame: Uint8Array, messageId: number): Uint8Array[] {
  if (!(frame instanceof Uint8Array)) {
    throw new ProtocolFrameError("invalid_frame", "fragment source must be a Uint8Array");
  }
  if (frame.byteLength < 1 || frame.byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolFrameError(
      "invalid_frame",
      `fragment source must be 1..${MAX_FRAME_BYTES} bytes`,
    );
  }
  if (frame[0] === FRAME_TYPES.FRAGMENT) {
    throw new ProtocolFrameError("invalid_frame", "nested FRAGMENT frames are not allowed");
  }
  if (!Number.isInteger(messageId) || messageId <= 0 || messageId > 0xffff_ffff) {
    throw new ProtocolFrameError("invalid_frame", "fragment messageId must be a non-zero u32");
  }

  const fragmentCount = Math.ceil(frame.byteLength / MAX_FRAGMENT_CHUNK_BYTES);
  const fragments: Uint8Array[] = [];
  for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
    const start = fragmentIndex * MAX_FRAGMENT_CHUNK_BYTES;
    const end = Math.min(start + MAX_FRAGMENT_CHUNK_BYTES, frame.byteLength);
    fragments.push(
      encodeFrame({
        type: "fragment",
        messageId,
        fragmentIndex,
        fragmentCount,
        totalBytes: frame.byteLength,
        payload: frame.subarray(start, end),
      }),
    );
  }
  return fragments;
}

/**
 * Send a frame directly over a DataChannel, splitting it when it exceeds the
 * DataChannel message budget. Returns false on any validation or send failure.
 */
export function sendFragments(
  send: (bytes: Uint8Array) => boolean,
  frame: Uint8Array,
  messageId: number,
): boolean {
  try {
    if (frame.byteLength < 1 || frame.byteLength > MAX_FRAME_BYTES) return false;
    if (frame[0] === FRAME_TYPES.FRAGMENT) return false;
    if (frame.byteLength <= MAX_DATACHANNEL_MESSAGE_BYTES) {
      return send(frame);
    }
    for (const fragment of fragmentFrame(frame, messageId)) {
      if (!send(fragment)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Bounded, per-peer reassembler for v1.1 `FRAGMENT` messages. */
export class FragmentReassembler {
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #timers: FragmentTimers;
  readonly #transfers = new Map<number, FragmentTransfer>();
  #bufferedBytes = 0;

  constructor(options: FragmentReassemblerOptions) {
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#timers = options.timers ?? defaultTimers;
  }

  get transferCount(): number {
    return this.#transfers.size;
  }

  /**
   * Accept one wire message. Returns the complete original frame bytes once all
   * fragments arrived, otherwise null. Non-fragment messages are ignored.
   */
  accept(bytes: Uint8Array): Uint8Array | null {
    let frame: ReturnType<typeof decodeFrame>;
    try {
      frame = decodeFrame(bytes);
    } catch (error) {
      this.#logger.debug(`ignoring malformed fragment message: ${String(error)}`);
      return null;
    }
    if (frame.type !== "fragment") {
      return null;
    }
    return this.#acceptFragment(frame);
  }

  reset(): void {
    for (const transfer of this.#transfers.values()) {
      this.#timers.clearTimeout(transfer.timer);
    }
    this.#transfers.clear();
    this.#bufferedBytes = 0;
  }

  dispose(): void {
    this.reset();
  }

  #acceptFragment(
    frame: Extract<ReturnType<typeof decodeFrame>, { type: "fragment" }>,
  ): Uint8Array | null {
    let transfer = this.#transfers.get(frame.messageId);
    if (
      transfer !== undefined &&
      (transfer.fragmentCount !== frame.fragmentCount || transfer.totalBytes !== frame.totalBytes)
    ) {
      this.#drop(frame.messageId, "fragment metadata changed");
      transfer = undefined;
    }

    if (transfer === undefined) {
      if (!this.#makeRoom(frame.totalBytes)) {
        this.#logger.debug(
          `dropped fragment transfer ${frame.messageId}: reassembly budget exhausted`,
        );
        return null;
      }
      const timer = this.#timers.setTimeout(() => {
        this.#drop(frame.messageId, "timeout");
      }, FRAGMENT_REASSEMBLY_TIMEOUT_MS);
      timer.unref?.();
      transfer = {
        messageId: frame.messageId,
        fragmentCount: frame.fragmentCount,
        totalBytes: frame.totalBytes,
        buffer: new Uint8Array(frame.totalBytes),
        received: new Uint8Array(frame.fragmentCount),
        receivedCount: 0,
        startedAt: this.#now(),
        timer,
      };
      this.#transfers.set(frame.messageId, transfer);
      this.#bufferedBytes += frame.totalBytes;
    }

    const offset = frame.fragmentIndex * MAX_FRAGMENT_CHUNK_BYTES;
    if (transfer.received[frame.fragmentIndex] === 1) {
      const existing = transfer.buffer.subarray(offset, offset + frame.payload.byteLength);
      if (!bytesEqual(existing, frame.payload)) {
        this.#drop(frame.messageId, "conflicting duplicate fragment");
      }
      return null;
    }

    transfer.buffer.set(frame.payload, offset);
    transfer.received[frame.fragmentIndex] = 1;
    transfer.receivedCount += 1;
    if (transfer.receivedCount !== transfer.fragmentCount) {
      return null;
    }

    this.#timers.clearTimeout(transfer.timer);
    this.#transfers.delete(frame.messageId);
    this.#bufferedBytes = Math.max(0, this.#bufferedBytes - transfer.totalBytes);

    const complete = transfer.buffer;
    if (complete[0] === FRAME_TYPES.FRAGMENT) {
      this.#logger.debug("dropped reassembled nested FRAGMENT frame");
      return null;
    }
    return complete;
  }

  #makeRoom(totalBytes: number): boolean {
    if (totalBytes > MAX_FRAGMENT_REASSEMBLY_BYTES) return false;
    const oldestFirst = [...this.#transfers.values()].sort(
      (left, right) => left.startedAt - right.startedAt,
    );
    while (
      oldestFirst.length > 0 &&
      (this.#transfers.size >= MAX_CONCURRENT_REASSEMBLIES ||
        this.#bufferedBytes + totalBytes > MAX_FRAGMENT_REASSEMBLY_BYTES)
    ) {
      const oldest = oldestFirst.shift();
      if (oldest !== undefined) {
        this.#drop(oldest.messageId, "evicted by reassembly limits");
      }
    }
    return (
      this.#transfers.size < MAX_CONCURRENT_REASSEMBLIES &&
      this.#bufferedBytes + totalBytes <= MAX_FRAGMENT_REASSEMBLY_BYTES
    );
  }

  #drop(messageId: number, reason: string): void {
    const transfer = this.#transfers.get(messageId);
    if (transfer === undefined) return;
    this.#timers.clearTimeout(transfer.timer);
    this.#transfers.delete(messageId);
    this.#bufferedBytes = Math.max(0, this.#bufferedBytes - transfer.totalBytes);
    this.#logger.debug(`dropped fragment transfer ${messageId}: ${reason}`);
  }
}
