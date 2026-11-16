/**
 * Output-sequence reducer for attach clients.
 *
 * A snapshot binds the viewer to a sequence number N. Only OUTPUT frames with
 * sequence > N are applied; the next expected frame is exactly N+1. Anything
 * older is ignored, and a forward gap requests a fresh snapshot.
 */
export type OutputDecision = "apply" | "ignore" | "gap";

/**
 * True when a snapshot would move the viewer backwards.
 *
 * A snapshot with `seq === lastSeq` is still applied (idempotent); only a
 * strictly older snapshot is stale. This protects the fallback/retry race
 * where an old DataChannel snapshot arrives after a newer relay snapshot.
 */
export function isStaleSnapshot(lastSeq: number | null, seq: number): boolean {
  return lastSeq !== null && seq < lastSeq;
}

export class SeqReducer {
  #lastSeq: number | null = null;

  get lastSeq(): number | null {
    return this.#lastSeq;
  }

  get hasSnapshot(): boolean {
    return this.#lastSeq !== null;
  }

  /** Clear state so output is ignored until the next snapshot arrives. */
  reset(): void {
    this.#lastSeq = null;
  }

  applySnapshot(seq: number): void {
    this.#lastSeq = seq;
  }

  classify(seq: number): OutputDecision {
    const last = this.#lastSeq;
    if (last === null) return "ignore";
    if (seq <= last) return "ignore";
    if (seq === last + 1) {
      this.#lastSeq = seq;
      return "apply";
    }
    return "gap";
  }
}
