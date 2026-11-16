import { describe, expect, it } from "vitest";

import { computeCamera, computeViewportFrame } from "./geometry.js";
import { MouseInputTranslator } from "./mouse.js";

const logical = { cols: 120, rows: 40 };
const frame = computeViewportFrame({ cols: 100, rows: 30 }, logical, 8);
const camera = computeCamera(logical, frame.viewport, { x: 60, y: 20 });

const decoder = new TextDecoder();

function translator(encodeSgr = true): MouseInputTranslator {
  const mouse = new MouseInputTranslator();
  mouse.setMap({ frame, camera });
  mouse.setEncodeSgr(encodeSgr);
  return mouse;
}

describe("MouseInputTranslator", () => {
  it("maps SGR clicks from the viewport into the logical grid", () => {
    const mouse = translator(true);
    const output = decoder.decode(mouse.translate(Buffer.from("\x1b[<0;1;1M")));
    expect(output).toBe("\x1b[<0;11;11M");
  });

  it("preserves release, wheel, and modifier buttons", () => {
    const mouse = translator(true);
    expect(decoder.decode(mouse.translate(Buffer.from("\x1b[<0;1;1m")))).toBe("\x1b[<0;11;11m");
    expect(decoder.decode(mouse.translate(Buffer.from("\x1b[<64;2;2M")))).toBe("\x1b[<64;12;12M");
    expect(decoder.decode(mouse.translate(Buffer.from("\x1b[<18;3;3M")))).toBe("\x1b[<18;13;13M");
  });

  it("re-encodes to legacy X10 when the remote did not enable SGR", () => {
    const mouse = translator(false);
    const output = mouse.translate(Buffer.from("\x1b[<0;1;1M"));
    expect([...output]).toEqual([0x1b, 0x5b, 0x4d, 32, 32 + 11, 32 + 11]);

    const release = mouse.translate(Buffer.from("\x1b[<0;1;1m"));
    expect([...release]).toEqual([0x1b, 0x5b, 0x4d, 32 + 3, 32 + 11, 32 + 11]);
  });

  it("drops clicks in letterbox margins or outside the logical grid", () => {
    const fitted = computeViewportFrame({ cols: 140, rows: 50 }, logical, 8);
    const fitCamera = computeCamera(logical, fitted.viewport, { x: 0, y: 0 });
    const mouse = new MouseInputTranslator();
    mouse.setMap({ frame: fitted, camera: fitCamera });
    mouse.setEncodeSgr(true);
    expect(mouse.translate(Buffer.from("\x1b[<0;1;1M")).byteLength).toBe(0);
    expect(mouse.translate(Buffer.from("\x1b[<0;11;1M")).byteLength).toBeGreaterThan(0);

    const cropped = translator(true);
    expect(cropped.translate(Buffer.from("\x1b[<0;101;1M")).byteLength).toBe(0);
  });

  it("buffers split mouse sequences and flushes lone escapes", () => {
    const mouse = translator(true);
    expect(mouse.translate(Buffer.from("\x1b[<0;1")).byteLength).toBe(0);
    expect(mouse.hasPending).toBe(true);
    expect(decoder.decode(mouse.translate(Buffer.from(";1M")))).toBe("\x1b[<0;11;11M");

    const lone = translator(true);
    expect(lone.translate(Buffer.from("\x1b")).byteLength).toBe(0);
    expect(lone.hasPending).toBe(true);
    expect([...lone.flushPending()]).toEqual([0x1b]);
  });

  it("passes ordinary input through unchanged", () => {
    const mouse = translator(true);
    expect([...mouse.translate(Buffer.from("abc\x1b[A"))]).toEqual([
      0x61, 0x62, 0x63, 0x1b, 0x5b, 0x41,
    ]);
  });
});
