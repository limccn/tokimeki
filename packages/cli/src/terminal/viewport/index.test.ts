import { describe, expect, it } from "vitest";

import { TerminalMirror } from "../mirror.js";
import { ModeTracker } from "../mode-tracker.js";
import { LocalViewport } from "./index.js";
import type { MenuAction } from "./menu.js";

function createStream(): { stream: NodeJS.WriteStream; text: () => string } {
  let text = "";
  const stream = {
    isTTY: true,
    columns: 100,
    rows: 30,
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

describe("LocalViewport local menu and log view", () => {
  it("intercepts F12, consumes modal keys, copies, and resumes normal input", () => {
    const mirror = new TerminalMirror({ cols: 20, rows: 5, scrollback: 5 });
    const tracker = new ModeTracker();
    const { stream, text } = createStream();
    const sent: string[] = [];
    const actions: MenuAction[] = [];
    const revealStates: boolean[] = [];
    const viewport = new LocalViewport({
      mirror,
      tracker,
      stdout: stream,
      logViewRows: 0,
      status: {
        role: "host",
        session: "demo",
        relayState: "ready",
        viewers: 0,
        transport: "relay",
        inviteHint: "f12:menu",
      },
      menu: {
        key: "f12",
        role: "host",
        getModel: ({ revealToken }) => {
          revealStates.push(revealToken);
          return {
            title: "TOKIMEKI CONNECTION",
            lines: ["session: demo", `token: ${revealToken ? "secret-token" : "secr…oken"}`],
            items: [
              { id: "status", label: "Refresh status" },
              { id: "show-token", label: "Show/hide token" },
              { id: "copy-config", label: "Copy config" },
              { id: "reconnect", label: "Reconnect" },
            ],
          };
        },
        onAction: (action) => actions.push(action),
        copyText: '{"v":1}',
      },
      onInput: (data) => sent.push(new TextDecoder().decode(data)),
    });
    try {
      viewport.start();
      viewport.handleInput(Buffer.from("a\x1b[24~"));
      expect(sent).toEqual(["a"]);
      expect(text()).toContain("TOKIMEKI CONNECTION");
      expect(text()).toContain("session: demo");
      expect(text()).toContain("secr…oken");

      viewport.handleInput(Buffer.from("s"));
      expect(text()).toContain("secret-token");
      expect(revealStates.at(-1)).toBe(true);

      viewport.handleInput(Buffer.from("c"));
      expect(sent).toEqual(["a"]);
      expect(text()).toContain("\x1b]52;c;");
      expect(text()).toContain(Buffer.from('{"v":1}', "utf8").toString("base64"));

      viewport.handleInput(Buffer.from("4"));
      expect(actions).toEqual([{ type: "reconnect" }]);

      viewport.handleInput(Buffer.from("b"));
      expect(sent).toEqual(["a", "b"]);
    } finally {
      viewport.restoreSync();
      mirror.dispose();
    }
  });

  it("closes the menu without forwarding Esc or menu bytes", () => {
    const mirror = new TerminalMirror({ cols: 20, rows: 5, scrollback: 5 });
    const tracker = new ModeTracker();
    const { stream } = createStream();
    const sent: string[] = [];
    const viewport = new LocalViewport({
      mirror,
      tracker,
      stdout: stream,
      logViewRows: 0,
      status: {
        role: "viewer",
        session: "demo",
        relayState: "ready",
        viewers: 0,
        transport: "relay",
      },
      menu: {
        key: "f12",
        role: "viewer",
        getModel: () => ({
          title: "MENU",
          lines: [],
          items: [{ id: "status", label: "Refresh" }],
        }),
        onAction: () => {},
        copyText: "{}",
      },
      onInput: (data) => sent.push(new TextDecoder().decode(data)),
    });
    try {
      viewport.start();
      viewport.handleInput(Buffer.from("\x1b[24~z"));
      expect(sent).toEqual([]);
      viewport.handleInput(Buffer.from("\x1b"));
      expect(sent).toEqual([]);
      viewport.handleInput(Buffer.from("q"));
      expect(sent).toEqual(["q"]);
    } finally {
      viewport.restoreSync();
      mirror.dispose();
    }
  });

  it("toggles the full-screen log view with F11 and keeps it local", () => {
    const mirror = new TerminalMirror({ cols: 20, rows: 5, scrollback: 5 });
    const tracker = new ModeTracker();
    const { stream, text } = createStream();
    const sent: string[] = [];
    const viewport = new LocalViewport({
      mirror,
      tracker,
      stdout: stream,
      logViewRows: 50,
      status: {
        role: "viewer",
        session: "demo",
        relayState: "ready",
        viewers: 0,
        transport: "relay",
      },
      onInput: (data) => sent.push(new TextDecoder().decode(data)),
    });
    try {
      viewport.start();
      for (let index = 0; index < 40; index += 1) {
        viewport.appendLog(`line-${index}`);
      }
      viewport.handleInput(Buffer.from("\x1b[23~"));
      expect(text()).toContain("LOGS 40");
      expect(text()).toContain("line-39");
      viewport.handleInput(Buffer.from("\x1b[A"));
      expect(text()).toContain("scroll 1/");
      expect(sent).toEqual([]);
      viewport.handleInput(Buffer.from("\x1b[23~"));
      viewport.handleInput(Buffer.from("x"));
      expect(sent).toEqual(["x"]);
    } finally {
      viewport.restoreSync();
      mirror.dispose();
    }
  });
});
