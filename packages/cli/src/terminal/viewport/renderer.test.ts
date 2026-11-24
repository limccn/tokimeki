import { afterEach, describe, expect, it } from "vitest";

import { TerminalMirror } from "../mirror.js";
import { ViewportRenderer, type ViewportStatus } from "./renderer.js";

const created: Array<{ renderer: ViewportRenderer; mirror: TerminalMirror }> = [];

function createStream(
  cols: number,
  rows: number,
): {
  stream: NodeJS.WriteStream;
  text: () => string;
} {
  let text = "";
  const stream = {
    isTTY: true,
    columns: cols,
    rows,
    write(chunk: string | Uint8Array): boolean {
      text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
    once(): void {},
    on(): void {},
    removeListener(): void {},
  } as unknown as NodeJS.WriteStream;
  return { stream, text: () => text };
}

function status(overrides: Partial<ViewportStatus> = {}): ViewportStatus {
  return {
    role: "host",
    session: "demo-session",
    relayState: "ready",
    viewers: 2,
    transport: "relay",
    ...overrides,
  };
}

function createRenderer(
  cols: number,
  rows: number,
  logical: { cols: number; rows: number },
  logViewRows: number,
  cursorVisible = true,
): { renderer: ViewportRenderer; mirror: TerminalMirror; text: () => string } {
  const mirror = new TerminalMirror({
    cols: logical.cols,
    rows: logical.rows,
    scrollback: 20,
  });
  const { stream, text } = createStream(cols, rows);
  const renderer = new ViewportRenderer({
    mirror,
    stdout: stream,
    logical,
    logViewRows,
    status: status(),
    isCursorVisible: () => cursorVisible,
  });
  created.push({ renderer, mirror });
  return { renderer, mirror, text };
}

afterEach(() => {
  for (const entry of created.splice(0)) {
    entry.renderer.dispose();
    entry.mirror.dispose();
  }
});

describe("ViewportRenderer", () => {
  it("buffers output until start so the startup banner is not overwritten", async () => {
    const { renderer, mirror, text } = createRenderer(100, 30, { cols: 40, rows: 3 }, 0);
    mirror.write(new TextEncoder().encode("early output"));
    await mirror.flush();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(text()).toBe("");

    renderer.start();
    expect(text()).toContain("early output");
  });

  it("renders the fixed grid centered with a reverse-video status bar", async () => {
    const { renderer, mirror, text } = createRenderer(100, 30, { cols: 10, rows: 3 }, 0);
    mirror.write(new TextEncoder().encode("hello"));
    await mirror.flush();
    renderer.start();

    const output = text();
    expect(output).toContain("hello");
    expect(output).toContain("\x1b[7m");
    expect(output).toContain("view:fit");
    expect(output).toContain("viewers=2");
    expect(output).toContain("session=demo-session");
    expect(output).not.toContain("session-token");
  });

  it("reserves a bottom-right log area on wide terminals only", () => {
    const wide = createRenderer(140, 50, { cols: 10, rows: 3 }, 8);
    wide.renderer.start();
    wide.renderer.appendLog("debug line 1");
    wide.renderer.renderNow();
    const wideOutput = wide.text();
    expect(wideOutput).toContain("debug line 1");
    expect(wideOutput).toContain("\x1b[2m");
    expect(wideOutput).toContain("\x1b[42;101H"); // corner log origin (0-based 41/100)

    const narrow = createRenderer(100, 30, { cols: 10, rows: 3 }, 8);
    narrow.renderer.start();
    narrow.renderer.appendLog("no bottom panel");
    narrow.renderer.renderNow();
    expect(narrow.text()).not.toContain("no bottom panel");
  });

  it("switches corner layout with 120/118 hysteresis", () => {
    const { renderer } = createRenderer(100, 30, { cols: 10, rows: 3 }, 8);
    renderer.start();
    expect(renderer.layout.frame.mode).toBe("narrow");
    renderer.resize({ cols: 124, rows: 30 });
    expect(renderer.layout.frame.mode).toBe("corner");
    renderer.resize({ cols: 119, rows: 30 });
    expect(renderer.layout.frame.mode).toBe("corner");
    renderer.resize({ cols: 117, rows: 30 });
    expect(renderer.layout.frame.mode).toBe("narrow");
  });

  it("shows the crop camera in the status bar", async () => {
    const { renderer, mirror, text } = createRenderer(60, 15, { cols: 120, rows: 40 }, 0);
    mirror.write(new TextEncoder().encode("x"));
    await mirror.flush();
    renderer.start();

    expect(text()).toContain("view:60x14@");
  });

  it("positions the cursor and hides it when requested", async () => {
    const visible = createRenderer(100, 30, { cols: 10, rows: 3 }, 0, true);
    visible.mirror.write(new TextEncoder().encode("hi"));
    await visible.mirror.flush();
    visible.renderer.start();
    expect(visible.text()).toContain("\x1b[?25h");

    const hidden = createRenderer(100, 30, { cols: 10, rows: 3 }, 0, false);
    hidden.renderer.start();
    expect(hidden.text()).toContain("\x1b[?25l");
  });

  it("shows and hides the local menu overlay", async () => {
    const { renderer, mirror, text } = createRenderer(100, 30, { cols: 20, rows: 5 }, 0);
    mirror.write(new TextEncoder().encode("hello"));
    await mirror.flush();
    renderer.start();

    const invite = '{"v":1,"session":"demo","sessionToken":"secret"}';
    renderer.setCopyText(invite);
    renderer.setMenuOverlay(["TOKIMEKI CONNECTION", "session: demo", "token: secre…cret"]);
    const overlay = text();
    expect(overlay).toContain("TOKIMEKI CONNECTION");
    expect(overlay).toContain("session: demo");
    expect(overlay).toContain("token: secre…cret");

    const beforeCopy = text().length;
    renderer.copyInvite();
    expect(text().slice(beforeCopy)).toContain("\x1b]52;c;");
    expect(text().slice(beforeCopy)).toContain(Buffer.from(invite, "utf8").toString("base64"));

    renderer.setMenuOverlay(null);
    renderer.renderNow();
    expect(text().includes("hello")).toBe(true);
  });

  it("shows the local menu hint in the status bar", async () => {
    const mirror = new TerminalMirror({ cols: 20, rows: 5, scrollback: 5 });
    const { stream, text } = createStream(120, 30);
    const renderer = new ViewportRenderer({
      mirror,
      stdout: stream,
      logical: { cols: 20, rows: 5 },
      logViewRows: 0,
      status: { ...status(), inviteHint: "f12:menu" },
      isCursorVisible: () => true,
    });
    created.push({ renderer, mirror });
    renderer.start();
    expect(text()).toContain("f12:menu");
  });

  it("renders the full-screen log view and scrolls through the ring", () => {
    const { renderer, text } = createRenderer(100, 30, { cols: 10, rows: 3 }, 100);
    renderer.start();
    for (let index = 0; index < 40; index += 1) {
      renderer.appendLog(`line-${index}`);
    }
    renderer.setLogView(true);
    expect(text()).toContain("LOGS 40");
    expect(text()).toContain("line-39");
    const before = text().length;
    renderer.scrollLogBy(1);
    expect(text().slice(before)).toContain("scroll 1/");
    renderer.setLogView(false);
    renderer.renderNow();
    expect(text()).toContain("view:fit");
  });

  it("repaints after a resize without changing the logical grid", async () => {
    const { renderer, mirror, text } = createRenderer(100, 30, { cols: 10, rows: 3 }, 0);
    mirror.write(new TextEncoder().encode("resize"));
    await mirror.flush();
    renderer.start();
    const before = text().length;
    renderer.resize({ cols: 80, rows: 24 });
    renderer.renderNow();
    expect(text().length).toBeGreaterThan(before);
    expect(text()).toContain("view:fit");
  });
});
