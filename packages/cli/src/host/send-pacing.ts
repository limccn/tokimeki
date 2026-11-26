/**
 * v1.7 host send-path helpers, both disabled unless the matching env var is set.
 *
 * - `DrainWindow` watches one ready P2P/TUN link and reports when its send
 *   buffer stays backlogged but drains below a configured byte rate.
 * - `SendPacer` is a process-wide token bucket for snapshots and large OUTPUT
 *   frames; small OUTPUT interleaves ahead of queued snapshots.
 *
 * Neither helper changes the wire format. They only decide when the host hands
 * an already-encoded frame to the existing transport.
 */

/** A buffer below this size is treated as "no backlog", never as a slow link. */
export const DRAIN_BUFFER_FLOOR_BYTES = 65_536;
/** Drain measurements cover one window of this length. */
export const DRAIN_WINDOW_MS = 3_000;
/** How often the host samples each ready link; exported for the host timer. */
export const DRAIN_SAMPLE_MS = 250;
/** OUTPUT payloads at or below this size use the priority queue. */
export const SMALL_OUTPUT_MAX_BYTES = 1_024;
/** Pause the shared PTY when the pacer queues more than this many bytes. */
export const SEND_PACE_QUEUE_HIGH_WATER_BYTES = 1_048_576;
/** Resume the shared PTY once the pacer queue drains to this many bytes. */
export const SEND_PACE_QUEUE_LOW_WATER_BYTES = 262_144;
/** One snapshot must finish within this window even at a very low pace. */
export const SNAPSHOT_PACE_FLOOR_MS = 8_000;
/** Pacer tick interval; small enough to smooth a 16 KiB burst at 1 s budget. */
export const SEND_PACER_TICK_MS = 20;

export type DrainVerdict = "idle" | "observing" | "slow";

/**
 * Per-viewer slow-drain window.
 *
 * The host samples the link's buffered bytes (DataChannel `bufferedAmount` or
 * TUN `pendingBytes`) every `DRAIN_SAMPLE_MS`. A window only opens while the
 * buffer is at least `DRAIN_BUFFER_FLOOR_BYTES`; an idle link therefore never
 * falls back. Once a full `DRAIN_WINDOW_MS` has elapsed:
 *
 *   drained = startBuffered + bytesWritten - endBuffered
 *   rate    = drained / DRAIN_WINDOW_MS
 *
 * A rate below the configured threshold reports `slow`. Bytes that the host
 * successfully handed to this link during the window are recorded through
 * `noteWritten`; relay snapshots and other viewers' frames are not counted.
 */
export class DrainWindow {
  #startedAt: number | null = null;
  #startBuffered = 0;
  #bytesWritten = 0;

  get active(): boolean {
    return this.#startedAt !== null;
  }

  /** Count one OUTPUT frame actually queued on this link. */
  noteWritten(bytes: number): void {
    if (this.#startedAt === null || !Number.isFinite(bytes) || bytes <= 0) return;
    this.#bytesWritten += bytes;
  }

  reset(): void {
    this.#startedAt = null;
    this.#startBuffered = 0;
    this.#bytesWritten = 0;
  }

  observe(now: number, bufferedBytes: number, thresholdBytesPerSec: number): DrainVerdict {
    if (!(thresholdBytesPerSec > 0)) return "idle";
    if (!(bufferedBytes >= DRAIN_BUFFER_FLOOR_BYTES)) {
      this.reset();
      return "idle";
    }
    if (this.#startedAt === null) {
      this.#startedAt = now;
      this.#startBuffered = bufferedBytes;
      this.#bytesWritten = 0;
      return "observing";
    }
    if (now - this.#startedAt < DRAIN_WINDOW_MS) {
      return "observing";
    }
    const drained = this.#startBuffered + this.#bytesWritten - bufferedBytes;
    const rate = (drained * 1000) / DRAIN_WINDOW_MS;
    this.reset();
    if (rate < thresholdBytesPerSec) {
      return "slow";
    }
    // Healthy links start a fresh window from the current buffer so the host
    // keeps watching without a sampling gap.
    this.#startedAt = now;
    this.#startBuffered = bufferedBytes;
    return "observing";
  }
}

export interface SendPacerJob {
  /** `output` jobs carry the incremental seq stream and must stay ordered. */
  readonly kind: "output" | "snapshot";
  /** Small OUTPUT (payload <= `SMALL_OUTPUT_MAX_BYTES`) uses the priority queue. */
  readonly priority: boolean;
  /** Wire size of the encoded frame this job hands to the transport. */
  readonly bytes: number;
  /** Called once when the bucket allows this job. */
  readonly send: () => void;
}

export interface PacerTimers {
  setInterval(handler: () => void, ms: number): NodeJS.Timeout;
  clearInterval(timer: NodeJS.Timeout): void;
}

export interface SendPacerOptions {
  readonly bytesPerSecond: number;
  readonly now?: () => number;
  readonly timers?: PacerTimers;
  /** Called once when the queue crosses the high-water mark. */
  readonly onQueueHighWater?: () => void;
  /** Called once when the queue drains back under the low-water mark. */
  readonly onQueueLowWater?: () => void;
}

interface PacerEntry {
  readonly job: SendPacerJob;
  readonly enqueuedAt: number;
}

const defaultTimers: PacerTimers = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (timer) => clearInterval(timer),
};

/**
 * Process-wide send pacer.
 *
 * The bucket holds one second of the configured rate and refills linearly; each
 * written frame is charged its full wire size. Frames are atomic here because
 * the relay has no sub-frame fragmentation: a snapshot larger than the bucket
 * is allowed to burst as soon as the bucket is full, and the bucket resets to
 * zero afterwards.
 *
 * Jobs are held in two logical queues. When a large OUTPUT is pending, newer
 * small OUTPUT waits so the viewer's seq reducer never sees an avoidable gap.
 * Small OUTPUT may overtake a queued snapshot to keep interactive latency low;
 * a viewer that already applied newer OUTPUT treats that snapshot as stale and
 * requests a resync when it needs the boundary. A snapshot that cannot start
 * within `SNAPSHOT_PACE_FLOOR_MS` is forced ahead of the priority queue so one
 * snapshot never occupies the pacer for more than eight seconds.
 */
export class SendPacer {
  readonly #rate: number;
  readonly #capacity: number;
  readonly #now: () => number;
  readonly #timers: PacerTimers;
  readonly #onQueueHighWater: (() => void) | undefined;
  readonly #onQueueLowWater: (() => void) | undefined;
  readonly #priority: PacerEntry[] = [];
  readonly #normal: PacerEntry[] = [];
  #normalOutputs = 0;
  #queuedBytes = 0;
  #tokens: number;
  #lastRefillAt: number;
  #highWater = false;
  #ticker: NodeJS.Timeout | null = null;
  #disposed = false;

  constructor(options: SendPacerOptions) {
    if (!Number.isFinite(options.bytesPerSecond) || options.bytesPerSecond <= 0) {
      throw new RangeError("SendPacer requires a positive bytesPerSecond");
    }
    this.#rate = options.bytesPerSecond;
    this.#capacity = Math.max(1, options.bytesPerSecond);
    this.#tokens = this.#capacity;
    this.#now = options.now ?? Date.now;
    this.#timers = options.timers ?? defaultTimers;
    this.#onQueueHighWater = options.onQueueHighWater;
    this.#onQueueLowWater = options.onQueueLowWater;
    this.#lastRefillAt = this.#now();
  }

  get queuedBytes(): number {
    return this.#queuedBytes;
  }

  get queuedJobs(): number {
    return this.#priority.length + this.#normal.length;
  }

  enqueue(job: SendPacerJob): void {
    if (this.#disposed || !(job.bytes > 0)) return;
    const entry: PacerEntry = { job, enqueuedAt: this.#now() };
    if (job.priority) {
      this.#priority.push(entry);
    } else {
      this.#normal.push(entry);
      if (job.kind === "output") this.#normalOutputs += 1;
    }
    this.#queuedBytes += job.bytes;
    this.#updateWater();
    this.#ensureTicker();
    this.pump();
  }

  /** Send every queued job in selection order, ignoring the token budget. */
  flush(): void {
    if (this.#disposed) return;
    const now = this.#now();
    for (;;) {
      const entry = this.#nextEntry(now);
      if (entry === undefined) break;
      this.#removeEntry(entry);
      this.#invoke(entry.job);
      if (this.#disposed) return;
    }
    this.#tokens = 0;
    this.#stopTicker();
  }

  pump(): void {
    if (this.#disposed) return;
    const now = this.#now();
    this.#refill(now);
    for (;;) {
      const entry = this.#nextEntry(now);
      if (entry === undefined) break;
      const oversized = entry.job.bytes > this.#capacity;
      const fits = oversized ? this.#tokens >= this.#capacity : this.#tokens >= entry.job.bytes;
      const forced =
        entry.job.kind === "snapshot" && now - entry.enqueuedAt >= SNAPSHOT_PACE_FLOOR_MS;
      if (!fits && !forced) break;
      this.#removeEntry(entry);
      if (oversized) {
        this.#tokens = 0;
      } else {
        this.#tokens = Math.max(0, this.#tokens - entry.job.bytes);
      }
      this.#invoke(entry.job);
      if (this.#disposed) return;
    }
    if (this.#priority.length === 0 && this.#normal.length === 0) {
      this.#stopTicker();
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopTicker();
    this.#priority.length = 0;
    this.#normal.length = 0;
    this.#normalOutputs = 0;
    this.#queuedBytes = 0;
  }

  #invoke(job: SendPacerJob): void {
    try {
      job.send();
    } catch {
      // The host callback logs its own send failures; one bad job must not
      // stall the rest of the queue.
    }
  }

  #refill(now: number): void {
    const elapsed = now - this.#lastRefillAt;
    if (elapsed <= 0) return;
    this.#lastRefillAt = now;
    this.#tokens = Math.min(this.#capacity, this.#tokens + (elapsed * this.#rate) / 1000);
  }

  #nextEntry(now: number): PacerEntry | undefined {
    const due = this.#normal.find(
      (entry) => entry.job.kind === "snapshot" && now - entry.enqueuedAt >= SNAPSHOT_PACE_FLOOR_MS,
    );
    if (due !== undefined) return due;
    const priority = this.#priority[0];
    const normal = this.#normal[0];
    if (priority === undefined) return normal;
    if (normal === undefined) return priority;
    // A pending large OUTPUT is older than every queued small OUTPUT; sending
    // the small one first would open a seq gap. Snapshots carry no incremental
    // seq, so the priority queue may pass them.
    if (this.#normalOutputs > 0) return normal;
    return priority;
  }

  #removeEntry(entry: PacerEntry): void {
    const queue = entry.job.priority ? this.#priority : this.#normal;
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    if (!entry.job.priority && entry.job.kind === "output") {
      this.#normalOutputs = Math.max(0, this.#normalOutputs - 1);
    }
    this.#queuedBytes = Math.max(0, this.#queuedBytes - entry.job.bytes);
    this.#updateWater();
  }

  #updateWater(): void {
    if (!this.#highWater && this.#queuedBytes > SEND_PACE_QUEUE_HIGH_WATER_BYTES) {
      this.#highWater = true;
      this.#onQueueHighWater?.();
      return;
    }
    if (this.#highWater && this.#queuedBytes <= SEND_PACE_QUEUE_LOW_WATER_BYTES) {
      this.#highWater = false;
      this.#onQueueLowWater?.();
    }
  }

  #ensureTicker(): void {
    if (this.#disposed || this.#ticker !== null) return;
    if (this.#priority.length === 0 && this.#normal.length === 0) return;
    const timer = this.#timers.setInterval(() => this.pump(), SEND_PACER_TICK_MS);
    timer.unref?.();
    this.#ticker = timer;
  }

  #stopTicker(): void {
    if (this.#ticker === null) return;
    this.#timers.clearInterval(this.#ticker);
    this.#ticker = null;
  }
}
