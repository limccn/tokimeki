/**
 * Fixed-capacity byte ring holding the most recent raw PTY output.
 *
 * It is the degraded snapshot source when xterm serialization fails or the
 * serialized screen still exceeds `TOKIMEKI_SNAPSHOT_MAX_BYTES`.
 */
export class ByteRing {
  readonly #buffer: Uint8Array;
  #writeIndex = 0;
  #length = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("ByteRing capacity must be a positive integer");
    }
    this.#buffer = new Uint8Array(capacity);
  }

  get capacity(): number {
    return this.#buffer.byteLength;
  }

  get length(): number {
    return this.#length;
  }

  clear(): void {
    this.#writeIndex = 0;
    this.#length = 0;
  }

  push(chunk: Uint8Array): void {
    const capacity = this.#buffer.byteLength;
    if (chunk.byteLength >= capacity) {
      this.#buffer.set(chunk.subarray(chunk.byteLength - capacity));
      this.#writeIndex = 0;
      this.#length = capacity;
      return;
    }
    const first = Math.min(chunk.byteLength, capacity - this.#writeIndex);
    this.#buffer.set(chunk.subarray(0, first), this.#writeIndex);
    const second = chunk.byteLength - first;
    if (second > 0) {
      this.#buffer.set(chunk.subarray(first), 0);
    }
    this.#writeIndex = (this.#writeIndex + chunk.byteLength) % capacity;
    this.#length = Math.min(capacity, this.#length + chunk.byteLength);
  }

  /** Copy the retained bytes into a fresh buffer, oldest byte first. */
  toBuffer(): Buffer {
    const capacity = this.#buffer.byteLength;
    const start = (this.#writeIndex - this.#length + capacity) % capacity;
    const output = Buffer.allocUnsafe(this.#length);
    const first = Math.min(this.#length, capacity - start);
    output.set(this.#buffer.subarray(start, start + first), 0);
    const remaining = this.#length - first;
    if (remaining > 0) {
      output.set(this.#buffer.subarray(0, remaining), first);
    }
    return output;
  }
}
