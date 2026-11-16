import { describe, expect, it } from "vitest";

import { InviteKeyController } from "./invite.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function f12(): InviteKeyController {
  return new InviteKeyController("f12");
}

describe("InviteKeyController", () => {
  it("opens on F12 and consumes bytes after the trigger", () => {
    const controller = f12();
    const result = controller.handle(encoder.encode("a\x1b[24~b"));
    expect(result).toMatchObject({ open: true, changed: true });
    expect(decoder.decode(result.remaining)).toBe("a");
    expect(controller.open).toBe(true);
  });

  it("recognizes F12 split across chunks and modifier variants", () => {
    const split = f12();
    expect(split.handle(encoder.encode("\x1b[24")).open).toBe(false);
    expect(split.hasPending).toBe(true);
    expect(split.handle(encoder.encode("~")).open).toBe(true);

    const modified = f12();
    expect(modified.handle(encoder.encode("\x1b[24;2~")).open).toBe(true);
  });

  it("passes unrelated escape sequences through", () => {
    const controller = f12();
    expect(decoder.decode(controller.handle(encoder.encode("\x1b[24A")).remaining)).toBe(
      "\x1b[24A",
    );
    expect(decoder.decode(controller.handle(encoder.encode("\x1b[A")).remaining)).toBe("\x1b[A");
  });

  it("copies on c, closes on Esc, and consumes other keys while open", () => {
    const controller = f12();
    controller.handle(encoder.encode("\x1b[24~"));
    expect(controller.handle(encoder.encode("x"))).toMatchObject({
      open: true,
      changed: false,
      copyRequested: false,
    });
    expect(controller.handle(encoder.encode("c"))).toMatchObject({
      open: true,
      changed: false,
      copyRequested: true,
    });
    expect(controller.handle(encoder.encode("\x1b"))).toMatchObject({
      open: false,
      changed: true,
    });
  });

  it("supports Ctrl-] and flushes a lone partial prefix", () => {
    const controller = new InviteKeyController("ctrl-]");
    expect(controller.handle(encoder.encode("a\x1db")).remaining).toEqual(encoder.encode("a"));
    expect(controller.open).toBe(true);
    expect(controller.handle(encoder.encode("\x1d")).open).toBe(false);

    const pending = f12();
    expect(pending.handle(encoder.encode("\x1b[")).remaining.byteLength).toBe(0);
    expect(decoder.decode(pending.flushPending())).toBe("\x1b[");
  });
});
