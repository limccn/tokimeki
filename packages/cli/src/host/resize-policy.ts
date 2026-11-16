/**
 * Pure resize-policy resolution shared by local and remote resizes.
 *
 * `latest` follows the most recent resize request (local or viewer). The last
 * applied size is intentionally kept when a viewer leaves, so a later viewer
 * joining at the same dimensions does not trigger a needless PTY resize
 * (ConPTY redraws would otherwise mask snapshot bugs).
 *
 * `min` fits every writable viewer; with no viewers it falls back to the local
 * terminal size. `pinned` always uses TOKIMEKI_PTY_SIZE (or the startup size).
 * Observers never participate.
 */

import type { ResizePolicy } from "@limccn/tokimeki-protocol";

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export interface ResizePolicyInput {
  readonly policy: ResizePolicy;
  readonly local: TerminalSize;
  readonly startup: TerminalSize;
  readonly pinned: TerminalSize | null;
  readonly viewers: Iterable<TerminalSize>;
  readonly latest: TerminalSize;
}

export function resolveResize(input: ResizePolicyInput): TerminalSize {
  switch (input.policy) {
    case "pinned":
      return input.pinned ?? input.startup;
    case "min": {
      let cols = Number.POSITIVE_INFINITY;
      let rows = Number.POSITIVE_INFINITY;
      let any = false;
      for (const viewer of input.viewers) {
        any = true;
        cols = Math.min(cols, viewer.cols);
        rows = Math.min(rows, viewer.rows);
      }
      if (!any) return input.local;
      return { cols, rows };
    }
    default:
      return input.latest;
  }
}

export function sizesEqual(a: TerminalSize, b: TerminalSize): boolean {
  return a.cols === b.cols && a.rows === b.rows;
}

/**
 * Coordinator refinement: only resize the PTY when dimensions actually change.
 * A no-op resize on Windows ConPTY repaints the screen, which can hide
 * snapshot defects during reconnect tests.
 */
export function shouldApplyResize(current: TerminalSize, next: TerminalSize): boolean {
  return !sizesEqual(current, next);
}
