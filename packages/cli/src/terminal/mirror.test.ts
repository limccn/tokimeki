import { afterEach, describe, expect, it } from "vitest";

import { TerminalMirror } from "./mirror.js";

const encoder = new TextEncoder();
const created: TerminalMirror[] = [];

function createMirror(
  options: { cols?: number; rows?: number; scrollback?: number } = {},
): TerminalMirror {
  const mirror = new TerminalMirror({
    cols: options.cols ?? 40,
    rows: options.rows ?? 10,
    scrollback: options.scrollback ?? 100,
  });
  created.push(mirror);
  return mirror;
}

afterEach(() => {
  for (const mirror of created.splice(0)) mirror.dispose();
});

describe("TerminalMirror", () => {
  it("serializes earlier content within the scrollback window", async () => {
    const mirror = createMirror({ cols: 40, rows: 5, scrollback: 100 });
    let output = "";
    for (let index = 0; index < 30; index += 1) {
      output += `line-${index}\r\n`;
    }
    mirror.write(encoder.encode(output));
    await mirror.flush();

    const snapshot = mirror.serialize();
    expect(snapshot).toContain("line-0");
    expect(snapshot).toContain("line-29");
  });

  it("respects the requested scrollback when serializing", async () => {
    const mirror = createMirror({ cols: 40, rows: 3, scrollback: 100 });
    let output = "";
    for (let index = 0; index < 10; index += 1) {
      output += `entry-${index}\r\n`;
    }
    mirror.write(encoder.encode(output));
    await mirror.flush();

    expect(mirror.serialize(100)).toContain("entry-0");
    expect(mirror.serialize(0)).not.toContain("entry-0");
  });

  it("uses Unicode 11 widths for CJK cells", async () => {
    const mirror = createMirror();
    mirror.write(encoder.encode("你好"));
    await mirror.flush();

    expect(mirror.term.buffer.active.cursorX).toBe(4);
    expect(mirror.serialize()).toContain("你好");
  });

  it("parses chunks strictly in write order", async () => {
    const mirror = createMirror();
    mirror.write(encoder.encode("A"));
    mirror.write(encoder.encode("B"));
    mirror.write(encoder.encode("C"));
    await mirror.flush();

    const line = mirror.term.buffer.active.getLine(0);
    expect(line?.translateToString(true)).toBe("ABC");
  });

  it("serializes the alternate screen when it is active", async () => {
    const mirror = createMirror();
    mirror.write(encoder.encode("\x1b[?1049h\x1b[2J\x1b[HALT-MARK"));
    await mirror.flush();

    expect(mirror.serialize()).toContain("ALT-MARK");
  });

  it("resizes the mirror buffer", async () => {
    const mirror = createMirror({ cols: 40, rows: 10 });
    mirror.resize(100, 30);
    expect(mirror.cols).toBe(100);
    expect(mirror.rows).toBe(30);

    mirror.write(encoder.encode("x".repeat(90)));
    await mirror.flush();
    expect(mirror.term.buffer.active.cursorX).toBe(90);
  });

  it("reports parsed chunks and resets at a snapshot boundary", async () => {
    const mirror = createMirror({ cols: 40, rows: 5 });
    let parsed = 0;
    mirror.setOnParsed(() => {
      parsed += 1;
    });

    mirror.write(encoder.encode("old-content"));
    await mirror.flush();
    expect(parsed).toBe(1);
    expect(mirror.serialize()).toContain("old-content");

    mirror.resetAndWrite(encoder.encode("new-content"));
    await mirror.flush();
    expect(parsed).toBe(2);
    expect(mirror.serialize()).toContain("new-content");
    expect(mirror.serialize()).not.toContain("old-content");
  });
});
