/**
 * Selective-repeat ARQ for the TUN profile.
 *
 * This module is transport-agnostic: the caller seals/sends each record and
 * receives already-authenticated plaintext. It is deliberately conservative:
 * a fixed window, bounded buffers, a fixed retransmission budget, and a hard
 * tunnel failure that lets the session fall back to the relay.
 *
 * ACK semantics match the v1.1 TUN wire contract:
 * - `ackSeq` cumulatively acknowledges every data seq `< ackSeq`;
 * - `ackBits` bit `i` acknowledges `ackSeq + 1 + i` (i = 0..31).
 */

import { TUNNEL_MAX_FRAME_BYTES } from "@limccn/tokimeki-protocol";

export type ArqTimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface ArqTimers {
  setTimeout(handler: () => void, ms: number): ArqTimerHandle;
  clearTimeout(handle: ArqTimerHandle): void;
}

const defaultTimers: ArqTimers = {
  setTimeout: (handler, ms) => {
    const handle = globalThis.setTimeout(handler, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle);
  },
};

export const ARQ_MAX_FRAME_BYTES = TUNNEL_MAX_FRAME_BYTES;
export const ARQ_DEFAULT_WINDOW = 64;
export const ARQ_HARD_WINDOW = 256;
export const ARQ_MAX_PENDING_BYTES = 1_048_576;
export const ARQ_DEFAULT_RTO_MS = 200;
export const ARQ_MAX_RTO_MS = 5_000;
export const ARQ_MAX_RETRIES = 8;
export const ARQ_MAX_AGE_MS = 10_000;
export const ARQ_RECEIVE_BUFFER_RECORDS = 256;
export const ARQ_RECEIVE_BUFFER_BYTES = 1_048_576;
export const ARQ_RECEIVE_MAX_AGE_MS = 10_000;
export const ARQ_REPLAY_WINDOW = 1_024;
const UINT32_MAX = 0xffff_ffff;

export interface AckState {
  /** Next seq the receiver expects (cumulative ack). */
  readonly ackSeq: number;
  /** Bitmap for `ackSeq + 1 + i`. */
  readonly ackBits: number;
}

export type ArqFailureReason =
  | "window_exhausted"
  | "send_failed"
  | "retransmit_limit"
  | "retransmit_timeout"
  | "receive_buffer_exhausted"
  | "receive_timeout";

export interface SenderRecord {
  readonly seq: number;
  readonly ackSeq: number;
  readonly ackBits: number;
  readonly plaintext: Uint8Array;
}

export interface SelectiveRepeatSenderOptions {
  /** Seal and queue one record (also used for retransmissions). */
  readonly sealAndSend: (record: SenderRecord) => boolean;
  readonly onFailure: (reason: ArqFailureReason) => void;
  readonly onRetransmit?: (pendingCount: number) => void;
  /** Called when ACK progress lowers the unacknowledged queue. */
  readonly onAck?: (state: { pendingCount: number; pendingBytes: number }) => void;
  readonly windowSize?: number;
  readonly maxPendingBytes?: number;
  readonly rtoMs?: number;
  readonly maxRtoMs?: number;
  readonly maxRetries?: number;
  readonly maxAgeMs?: number;
  readonly timers?: ArqTimers;
  readonly now?: () => number;
}

interface PendingRecord {
  readonly plaintext: Uint8Array;
  readonly firstSentAt: number;
  retries: number;
}

function clampWindow(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) return ARQ_DEFAULT_WINDOW;
  return Math.min(value, ARQ_HARD_WINDOW);
}

export class SelectiveRepeatSender {
  readonly #options: SelectiveRepeatSenderOptions;
  readonly #timers: ArqTimers;
  readonly #now: () => number;
  readonly #windowSize: number;
  readonly #maxPendingBytes: number;
  readonly #rtoBase: number;
  readonly #maxRto: number;
  readonly #maxRetries: number;
  readonly #maxAgeMs: number;
  readonly #pending = new Map<number, PendingRecord>();

  #pendingBytes = 0;
  #nextSeq = 0;
  #ackState: AckState = { ackSeq: 0, ackBits: 0 };
  #rto: number;
  #timer: ArqTimerHandle | null = null;
  #failed = false;
  #disposed = false;

  constructor(options: SelectiveRepeatSenderOptions) {
    this.#options = options;
    this.#timers = options.timers ?? defaultTimers;
    this.#now = options.now ?? Date.now;
    this.#windowSize = clampWindow(options.windowSize);
    this.#maxPendingBytes = options.maxPendingBytes ?? ARQ_MAX_PENDING_BYTES;
    this.#rtoBase = options.rtoMs ?? ARQ_DEFAULT_RTO_MS;
    this.#maxRto = options.maxRtoMs ?? ARQ_MAX_RTO_MS;
    this.#maxRetries = options.maxRetries ?? ARQ_MAX_RETRIES;
    this.#maxAgeMs = options.maxAgeMs ?? ARQ_MAX_AGE_MS;
    this.#rto = this.#rtoBase;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  get nextSeq(): number {
    return this.#nextSeq;
  }

  get failed(): boolean {
    return this.#failed;
  }

  /** True when the u32 data sequence space is exhausted. */
  get seqExhausted(): boolean {
    return this.#nextSeq > UINT32_MAX;
  }

  /** Queue one application frame. False means the window or byte budget is full. */
  sendFrame(plaintext: Uint8Array): boolean {
    if (this.#failed || this.#disposed) return false;
    if (!(plaintext instanceof Uint8Array) || plaintext.byteLength > ARQ_MAX_FRAME_BYTES) {
      return false;
    }
    if (
      this.#pending.size >= this.#windowSize ||
      this.#pendingBytes + plaintext.byteLength > this.#maxPendingBytes ||
      this.#nextSeq > UINT32_MAX
    ) {
      return false;
    }
    const seq = this.#nextSeq;
    this.#nextSeq += 1;
    this.#pending.set(seq, { plaintext, firstSentAt: this.#now(), retries: 0 });
    this.#pendingBytes += plaintext.byteLength;
    if (!this.#transmit(seq)) {
      this.#fail("send_failed");
      return false;
    }
    this.#schedule();
    return true;
  }

  setAckState(ackSeq: number, ackBits: number): void {
    if (!Number.isInteger(ackSeq) || ackSeq < 0 || ackSeq > UINT32_MAX) return;
    if (!Number.isInteger(ackBits) || ackBits < 0 || ackBits > UINT32_MAX) return;
    this.#ackState = { ackSeq, ackBits };
  }

  /** Apply cumulative + selective acknowledgements from a peer record. */
  receiveAck(ackSeq: number, ackBits: number): void {
    if (this.#failed || this.#disposed) return;
    if (!Number.isInteger(ackSeq) || ackSeq < 0 || ackSeq > UINT32_MAX) return;
    if (!Number.isInteger(ackBits) || ackBits < 0 || ackBits > UINT32_MAX) return;

    let progress = false;
    for (const seq of [...this.#pending.keys()]) {
      if (seq < ackSeq) {
        this.#remove(seq);
        progress = true;
      }
    }
    for (let index = 0; index < 32; index += 1) {
      if (((ackBits >>> index) & 1) === 0) continue;
      const seq = ackSeq + 1 + index;
      if (seq > UINT32_MAX) break;
      if (this.#pending.has(seq)) {
        this.#remove(seq);
        progress = true;
      }
    }
    if (!progress) return;
    this.#rto = this.#rtoBase;
    this.#clearTimer();
    if (this.#pending.size > 0) this.#schedule();
    this.#options.onAck?.({
      pendingCount: this.#pending.size,
      pendingBytes: this.#pendingBytes,
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearTimer();
    this.#pending.clear();
    this.#pendingBytes = 0;
  }

  #remove(seq: number): void {
    const pending = this.#pending.get(seq);
    if (pending === undefined) return;
    this.#pending.delete(seq);
    this.#pendingBytes -= pending.plaintext.byteLength;
  }

  #transmit(seq: number): boolean {
    const pending = this.#pending.get(seq);
    if (pending === undefined) return true;
    return this.#options.sealAndSend({
      seq,
      ackSeq: this.#ackState.ackSeq,
      ackBits: this.#ackState.ackBits,
      plaintext: pending.plaintext,
    });
  }

  #schedule(): void {
    if (this.#timer !== null || this.#pending.size === 0 || this.#failed || this.#disposed) {
      return;
    }
    this.#timer = this.#timers.setTimeout(() => this.#onTimeout(), this.#rto);
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
  }

  #onTimeout(): void {
    this.#timer = null;
    if (this.#failed || this.#disposed || this.#pending.size === 0) return;

    const now = this.#now();
    for (const pending of this.#pending.values()) {
      if (now - pending.firstSentAt > this.#maxAgeMs) {
        this.#fail("retransmit_timeout");
        return;
      }
      pending.retries += 1;
      if (pending.retries > this.#maxRetries) {
        this.#fail("retransmit_limit");
        return;
      }
    }
    for (const seq of [...this.#pending.keys()]) {
      if (!this.#transmit(seq)) {
        this.#fail("send_failed");
        return;
      }
    }
    this.#options.onRetransmit?.(this.#pending.size);
    this.#rto = Math.min(this.#rto * 2, this.#maxRto);
    this.#schedule();
  }

  #fail(reason: ArqFailureReason): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#clearTimer();
    this.#pending.clear();
    this.#pendingBytes = 0;
    this.#options.onFailure(reason);
  }
}

export interface SelectiveRepeatReceiverOptions {
  readonly onFailure: (reason: ArqFailureReason) => void;
  readonly maxBufferedRecords?: number;
  readonly maxBufferedBytes?: number;
  readonly maxBufferedAgeMs?: number;
  readonly replayWindow?: number;
  readonly timers?: ArqTimers;
  readonly now?: () => number;
}

export interface ReceiveResult {
  /** Frames that became contiguous and may be delivered to the application. */
  readonly delivered: readonly Uint8Array[];
  readonly ack: AckState;
  /** True when the caller should send an ACK record (including duplicates). */
  readonly shouldAck: boolean;
  readonly failure?: ArqFailureReason;
}

interface BufferedRecord {
  readonly plaintext: Uint8Array;
  readonly receivedAt: number;
}

export class SelectiveRepeatReceiver {
  readonly #options: SelectiveRepeatReceiverOptions;
  readonly #timers: ArqTimers;
  readonly #now: () => number;
  readonly #maxRecords: number;
  readonly #maxBytes: number;
  readonly #maxAgeMs: number;
  readonly #replayWindow: number;
  readonly #buffer = new Map<number, BufferedRecord>();

  #nextExpected = 0;
  #bufferedBytes = 0;
  #failureTimer: ArqTimerHandle | null = null;
  #failed = false;
  #disposed = false;

  constructor(options: SelectiveRepeatReceiverOptions) {
    this.#options = options;
    this.#timers = options.timers ?? defaultTimers;
    this.#now = options.now ?? Date.now;
    this.#maxRecords = options.maxBufferedRecords ?? ARQ_RECEIVE_BUFFER_RECORDS;
    this.#maxBytes = options.maxBufferedBytes ?? ARQ_RECEIVE_BUFFER_BYTES;
    this.#maxAgeMs = options.maxBufferedAgeMs ?? ARQ_RECEIVE_MAX_AGE_MS;
    this.#replayWindow = options.replayWindow ?? ARQ_REPLAY_WINDOW;
  }

  get nextExpectedSeq(): number {
    return this.#nextExpected;
  }

  get bufferedCount(): number {
    return this.#buffer.size;
  }

  get bufferedBytes(): number {
    return this.#bufferedBytes;
  }

  get failed(): boolean {
    return this.#failed;
  }

  ackState(): AckState {
    let ackBits = 0;
    for (const seq of this.#buffer.keys()) {
      const delta = seq - this.#nextExpected;
      if (delta >= 1 && delta <= 32) {
        ackBits = (ackBits | (1 << (delta - 1))) >>> 0;
      }
    }
    return { ackSeq: this.#nextExpected, ackBits };
  }

  /**
   * Accept one authenticated plaintext record.
   *
   * `null` means the record is a replay outside the bounded window and was
   * dropped without an ACK. Duplicates inside the window re-ACK so a lost ACK
   * cannot stall the sender.
   */
  accept(seq: number, plaintext: Uint8Array): ReceiveResult | null {
    if (this.#failed || this.#disposed) return null;
    if (!Number.isInteger(seq) || seq < 0 || seq > UINT32_MAX) return null;
    if (!(plaintext instanceof Uint8Array)) return null;

    if (seq < this.#nextExpected) {
      if (this.#nextExpected - seq > this.#replayWindow) {
        return null;
      }
      return { delivered: [], ack: this.ackState(), shouldAck: true };
    }

    const existing = this.#buffer.get(seq);
    if (existing !== undefined) {
      return { delivered: [], ack: this.ackState(), shouldAck: true };
    }

    // The record that closes the current gap is inserted and drained in the
    // same call, so it never grows the buffer; rejecting it at the capacity
    // boundary would fail the tunnel instead of delivering the buffered run.
    const closesGap = seq === this.#nextExpected;
    if (
      !closesGap &&
      (this.#buffer.size >= this.#maxRecords ||
        this.#bufferedBytes + plaintext.byteLength > this.#maxBytes)
    ) {
      this.#fail("receive_buffer_exhausted");
      return {
        delivered: [],
        ack: this.ackState(),
        shouldAck: false,
        failure: "receive_buffer_exhausted",
      };
    }

    this.#buffer.set(seq, { plaintext, receivedAt: this.#now() });
    this.#bufferedBytes += plaintext.byteLength;
    this.#scheduleFailureTimer();

    const delivered: Uint8Array[] = [];
    while (true) {
      const next = this.#buffer.get(this.#nextExpected);
      if (next === undefined) break;
      this.#buffer.delete(this.#nextExpected);
      this.#bufferedBytes -= next.plaintext.byteLength;
      delivered.push(next.plaintext);
      this.#nextExpected += 1;
    }
    if (this.#buffer.size === 0) {
      this.#clearFailureTimer();
    }
    return { delivered, ack: this.ackState(), shouldAck: true };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearFailureTimer();
    this.#buffer.clear();
    this.#bufferedBytes = 0;
  }

  #scheduleFailureTimer(): void {
    if (this.#failureTimer !== null || this.#buffer.size === 0) return;
    this.#failureTimer = this.#timers.setTimeout(() => {
      this.#failureTimer = null;
      if (this.#failed || this.#disposed) return;
      if (this.#buffer.size === 0) return;
      const oldest = Math.min(...[...this.#buffer.values()].map((record) => record.receivedAt));
      if (this.#now() - oldest >= this.#maxAgeMs) {
        this.#fail("receive_timeout");
        return;
      }
      this.#scheduleFailureTimer();
    }, this.#maxAgeMs);
  }

  #clearFailureTimer(): void {
    if (this.#failureTimer === null) return;
    this.#timers.clearTimeout(this.#failureTimer);
    this.#failureTimer = null;
  }

  #fail(reason: ArqFailureReason): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#clearFailureTimer();
    this.#buffer.clear();
    this.#bufferedBytes = 0;
    this.#options.onFailure(reason);
  }
}
