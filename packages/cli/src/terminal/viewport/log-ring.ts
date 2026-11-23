/**
 * Bounded, redacted log ring for the local log views.
 *
 * Input lines are already redacted by the Logger. This ring additionally
 * strips control characters (except tab), caps each line, and bounds the ring
 * so log content can never forge terminal output or grow without limit.
 */

export const LOG_LINE_MAX_CHARS = 4096;

export function sanitizeLogLine(line: string): string {
  let result = "";
  for (const char of line) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      if (code === 0x09) result += " ";
    } else {
      result += char;
    }
    if (result.length >= LOG_LINE_MAX_CHARS) break;
  }
  return result;
}

export class LogRing {
  readonly #capacity: number;
  #lines: string[] = [];

  constructor(capacity: number) {
    this.#capacity = Math.max(0, Math.floor(capacity));
  }

  get capacity(): number {
    return this.#capacity;
  }

  get length(): number {
    return this.#lines.length;
  }

  get enabled(): boolean {
    return this.#capacity > 0;
  }

  push(line: string): void {
    if (this.#capacity === 0) return;
    for (const part of String(line).split(/\r?\n/)) {
      this.#lines.push(sanitizeLogLine(part));
    }
    if (this.#lines.length > this.#capacity) {
      this.#lines.splice(0, this.#lines.length - this.#capacity);
    }
  }

  /** All retained lines, oldest first. */
  entries(): readonly string[] {
    return this.#lines;
  }

  /** The last `count` lines ending `offset` lines before the newest. */
  tail(count: number, offset = 0): readonly string[] {
    const end = Math.max(0, this.#lines.length - Math.max(0, offset));
    const start = Math.max(0, end - Math.max(0, count));
    return this.#lines.slice(start, end);
  }

  clear(): void {
    this.#lines = [];
  }
}
