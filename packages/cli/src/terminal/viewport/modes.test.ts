import { describe, expect, it } from "vitest";

import { ModeSynchronizer } from "./modes.js";

describe("ModeSynchronizer", () => {
  it("enables the local mouse/focus/paste modes the TUI asks for", () => {
    const sync = new ModeSynchronizer();
    expect(
      sync.update({
        mouse: "vt200",
        mouseSgr: false,
        bracketedPaste: true,
        focusEvents: true,
      }),
    ).toBe("\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?1004h");
    expect(
      sync.update({
        mouse: "vt200",
        mouseSgr: false,
        bracketedPaste: true,
        focusEvents: true,
      }),
    ).toBe("");
  });

  it("switches mouse tracking modes and disables everything on reset", () => {
    const sync = new ModeSynchronizer();
    sync.update({ mouse: "vt200", mouseSgr: true, bracketedPaste: false, focusEvents: false });
    expect(
      sync.update({ mouse: "drag", mouseSgr: true, bracketedPaste: false, focusEvents: false }),
    ).toBe("\x1b[?1000l\x1b[?1002h");
    expect(
      sync.update({ mouse: "any", mouseSgr: true, bracketedPaste: false, focusEvents: false }),
    ).toBe("\x1b[?1002l\x1b[?1003h");
    expect(sync.reset()).toBe("\x1b[?1003l\x1b[?1006l");
    expect(sync.reset()).toBe("");
  });
});
