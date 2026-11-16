/**
 * Headless xterm.js mirror of the host PTY screen.
 *
 * PTY chunks are parsed by `@xterm/headless` with Unicode 11 width tables so
 * CJK/emoji cells match a real terminal. `@xterm/addon-serialize` turns the
 * buffer into ANSI text for reconnect snapshots.
 *
 * Writes are queued and processed in order; `flush()` resolves once every
 * chunk enqueued so far has been parsed, which is the boundary the host uses
 * before serializing a snapshot.
 */

import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { Terminal as HeadlessTerminal, IDisposable } from "@xterm/headless";
import headless from "@xterm/headless";

const { Terminal } = headless as { Terminal: typeof HeadlessTerminal };

export interface TerminalMirrorOptions {
  readonly cols: number;
  readonly rows: number;
  readonly scrollback: number;
  /** Receives terminal query replies generated while parsing PTY output. */
  readonly onReply?: (data: string) => void;
  /** Called after each queued chunk has been parsed (viewport invalidation). */
  readonly onParsed?: () => void;
}

export class TerminalMirror {
  readonly term: HeadlessTerminal;
  readonly #serializer = new SerializeAddon();
  readonly #replySubscription: IDisposable | null;
  #onParsed: (() => void) | null;
  #tail: Promise<void> = Promise.resolve();
  #disposed = false;
  #scrollback: number;

  constructor(options: TerminalMirrorOptions) {
    this.#scrollback = options.scrollback;
    this.term = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback,
      allowProposedApi: true,
    });
    const unicode = new Unicode11Addon();
    this.term.loadAddon(unicode);
    this.term.unicode.activeVersion = "11";
    this.term.loadAddon(this.#serializer);
    this.#replySubscription =
      options.onReply === undefined ? null : this.term.onData(options.onReply);
    this.#onParsed = options.onParsed ?? null;
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  get scrollback(): number {
    return this.#scrollback;
  }

  /** Replace the parsed-chunk callback (viewport attaches after construction). */
  setOnParsed(onParsed: (() => void) | null): void {
    this.#onParsed = onParsed;
  }

  /** Enqueue a PTY chunk for parsing. The buffer is copied. */
  write(chunk: Uint8Array): void {
    const copy = Uint8Array.from(chunk);
    this.#tail = this.#tail.then(() => this.#writeNow(copy));
  }

  /**
   * Reset the mirror, then parse a snapshot payload.
   *
   * Both operations are chained behind any previously queued writes, so a
   * snapshot boundary always wins over pre-snapshot output.
   */
  resetAndWrite(chunk: Uint8Array): void {
    const copy = Uint8Array.from(chunk);
    this.#tail = this.#tail.then(() => {
      if (this.#disposed) return;
      try {
        this.term.reset();
      } catch {
        // A disposed terminal is not fatal for snapshot recovery.
      }
      return this.#writeNow(copy);
    });
  }

  #writeNow(chunk: Uint8Array): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.#disposed) {
        resolve();
        return;
      }
      try {
        this.term.write(chunk, () => {
          this.#onParsed?.();
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }

  /** Resolve when all chunks enqueued before this call have been parsed. */
  async flush(): Promise<void> {
    const tail = this.#tail;
    try {
      await tail;
    } catch {
      // Parsing errors must not break snapshot generation.
    }
  }

  /**
   * Serialize the current screen. Call only after `flush()`.
   *
   * The caller passes a smaller scrollback value when the full snapshot is
   * too large; `configured scrollback` is used when omitted.
   */
  serialize(scrollback: number = this.#scrollback): string {
    return this.#serializer.serialize({ scrollback });
  }

  resize(cols: number, rows: number): void {
    if (this.#disposed) return;
    try {
      this.term.resize(cols, rows);
    } catch {
      // A disposed or mid-write terminal is not fatal for output forwarding.
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      this.#replySubscription?.dispose();
      this.term.dispose();
    } catch {
      // best effort
    }
  }
}
