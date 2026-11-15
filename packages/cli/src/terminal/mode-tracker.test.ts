import { describe, expect, it } from "vitest";

import { ModeTracker } from "./mode-tracker.js";

const encoder = new TextEncoder();

function apply(tracker: ModeTracker, text: string): void {
  tracker.apply(encoder.encode(text));
}

describe("ModeTracker", () => {
  it("recognizes private modes split across chunks", () => {
    const tracker = new ModeTracker();
    apply(tracker, "\x1b[?10");
    expect(tracker.modes.altScreen).toBe(false);
    apply(tracker, "49h");
    apply(tracker, "\x1b[?25");
    apply(tracker, "l");
    expect(tracker.modes.altScreen).toBe(true);
    expect(tracker.modes.cursorVisible).toBe(false);
    apply(tracker, "\x1b[?1049l\x1b[?25h");
    expect(tracker.modes.altScreen).toBe(false);
    expect(tracker.modes.cursorVisible).toBe(true);
  });

  it("tracks mouse encodings, paste, and focus events", () => {
    const tracker = new ModeTracker();
    apply(tracker, "\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?1004h");
    expect(tracker.modes.mouse1002).toBe(true);
    expect(tracker.modes.mouse1006).toBe(true);
    expect(tracker.modes.bracketedPaste).toBe(true);
    expect(tracker.modes.focusEvents).toBe(true);

    apply(tracker, "\x1b[?1002l\x1b[?1003h");
    expect(tracker.modes.mouse1002).toBe(false);
    expect(tracker.modes.mouse1003).toBe(true);
  });

  it("tracks synchronized output separately and never replays it", () => {
    const tracker = new ModeTracker();
    apply(tracker, "\x1b[?2026h");
    expect(tracker.synchronizedOutput).toBe(true);
    const replay = tracker.replaySequence();
    expect(replay).not.toContain("?2026h");
    apply(tracker, "\x1b[?2026l");
    expect(tracker.synchronizedOutput).toBe(false);
  });

  it("replays every missing replay-safe mode without re-entering the alt screen", () => {
    const tracker = new ModeTracker();
    apply(tracker, "\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[?25l");
    const replay = tracker.replaySequence();
    // SerializeAddon restores the alternate buffer itself; a second ?1049h can
    // clear the snapshot content on real terminals.
    expect(replay).not.toContain("\x1b[?1049h");
    expect(replay).toContain("\x1b[?1002h");
    expect(replay).toContain("\x1b[?1006h");
    expect(replay).toContain("\x1b[?2004h");
    expect(replay).toContain("\x1b[?1004h");
    expect(replay).toContain("\x1b[?25l");
    expect(replay).not.toContain("\x1b[?1000h");
    expect(replay).not.toContain("\x1b[?1003h");
  });

  it("replays the active mouse mode only", () => {
    const tracker = new ModeTracker();
    apply(tracker, "\x1b[?1003h\x1b[?1000h");
    const replay = tracker.replaySequence();
    expect(replay).toContain("\x1b[?1003h");
    expect(replay).not.toContain("\x1b[?1000h");
  });

  it("tracks the Kitty keyboard stack", () => {
    const tracker = new ModeTracker();
    apply(tracker, "\x1b[>1u");
    apply(tracker, "\x1b[>5u");
    expect(tracker.modes.kittyDepth).toBe(2);
    expect(tracker.modes.kittyFlags).toBe(5);
    expect(tracker.replaySequence()).toContain("\x1b[>5u");
    apply(tracker, "\x1b[<u");
    expect(tracker.modes.kittyDepth).toBe(1);
    apply(tracker, "\x1b[<u\x1b[<u");
    expect(tracker.modes.kittyDepth).toBe(0);
    expect(tracker.replaySequence()).not.toContain("\x1b[>");
  });

  it("ignores non-private and malformed sequences", () => {
    const tracker = new ModeTracker();
    apply(tracker, "\x1b[1;31m\x1b(B\x1b[?25h");
    expect(tracker.cursorVisible).toBe(true);
    apply(tracker, "\x1b[?25l");
    expect(tracker.cursorVisible).toBe(false);
  });
});
