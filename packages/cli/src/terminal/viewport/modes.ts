/**
 * Synchronize local-terminal input modes with the hosted TUI.
 *
 * The local terminal always reports mouse input as SGR (`?1006`) so the
 * translator can parse coordinates; the translator re-encodes to the remote
 * encoding. Focus and bracketed-paste modes are mirrored directly.
 */

import type { Terminal } from "@xterm/headless";

import type { ModeTracker } from "../mode-tracker.js";

export type MouseTracking = "none" | "x10" | "vt200" | "drag" | "any";

export interface TerminalInputModes {
  readonly mouse: MouseTracking;
  readonly mouseSgr: boolean;
  readonly bracketedPaste: boolean;
  readonly focusEvents: boolean;
}

interface SyncState {
  mouse1000: boolean;
  mouse1002: boolean;
  mouse1003: boolean;
  mouse1006: boolean;
  bracketedPaste: boolean;
  focusEvents: boolean;
}

function disabled(): SyncState {
  return {
    mouse1000: false,
    mouse1002: false,
    mouse1003: false,
    mouse1006: false,
    bracketedPaste: false,
    focusEvents: false,
  };
}

/** Read the modes the hosted TUI currently wants. */
export function readTerminalInputModes(term: Terminal, tracker: ModeTracker): TerminalInputModes {
  return {
    mouse: term.modes.mouseTrackingMode,
    mouseSgr: tracker.modes.mouse1006,
    bracketedPaste: term.modes.bracketedPasteMode,
    focusEvents: tracker.modes.focusEvents,
  };
}

/** Emit only the DECSET/DECRST changes needed for the new remote modes. */
export class ModeSynchronizer {
  #last: SyncState = disabled();

  update(next: TerminalInputModes): string {
    const desired = disabled();
    if (next.mouse !== "none") {
      if (next.mouse === "drag") desired.mouse1002 = true;
      else if (next.mouse === "any") desired.mouse1003 = true;
      else desired.mouse1000 = true;
      desired.mouse1006 = true;
    }
    desired.bracketedPaste = next.bracketedPaste;
    desired.focusEvents = next.focusEvents;

    const parts: string[] = [];
    const toggle = (code: number, enabled: boolean, name: keyof SyncState): void => {
      if (this.#last[name] === enabled) return;
      parts.push(`\x1b[?${code}${enabled ? "h" : "l"}`);
    };
    toggle(1000, desired.mouse1000, "mouse1000");
    toggle(1002, desired.mouse1002, "mouse1002");
    toggle(1003, desired.mouse1003, "mouse1003");
    toggle(1006, desired.mouse1006, "mouse1006");
    toggle(2004, desired.bracketedPaste, "bracketedPaste");
    toggle(1004, desired.focusEvents, "focusEvents");
    this.#last = desired;
    return parts.join("");
  }

  reset(): string {
    const parts: string[] = [];
    if (this.#last.mouse1000) parts.push("\x1b[?1000l");
    if (this.#last.mouse1002) parts.push("\x1b[?1002l");
    if (this.#last.mouse1003) parts.push("\x1b[?1003l");
    if (this.#last.mouse1006) parts.push("\x1b[?1006l");
    if (this.#last.bracketedPaste) parts.push("\x1b[?2004l");
    if (this.#last.focusEvents) parts.push("\x1b[?1004l");
    this.#last = disabled();
    return parts.join("");
  }
}
