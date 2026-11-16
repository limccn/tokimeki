import { describe, expect, it } from "vitest";

import { TerminalMirror } from "../mirror.js";
import { ModeTracker } from "../mode-tracker.js";
import { LocalViewport } from "./index.js";

function createStream(): { stream: NodeJS.WriteStream; text: () => string } {
  let text = "";
  const stream = {
    isTTY: true,
    columns: 80,
    rows: 24,
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

describe("LocalViewport invite overlay", () => {
  it("intercepts F12, consumes modal keys, copies, and resumes normal input", () => {
    const mirror = new TerminalMirror({ cols: 20, rows: 5, scrollback: 5 });
    const tracker = new ModeTracker();
    const { stream, text } = createStream();
    const sent: string[] = [];
    const viewport = new LocalViewport({
      mirror,
      tracker,
      stdout: stream,
      logRows: 0,
      status: {
        role: "host",
        session: "demo",
        relayState: "ready",
        viewers: 0,
        transport: "relay",
        inviteHint: "f12:invite",
      },
      invite: {
        key: "f12",
        lines: ["session: demo", "token: secret"],
        copyText: '{"v":1}',
      },
      onInput: (data) => sent.push(new TextDecoder().decode(data)),
    });
    try {
      viewport.start();
      viewport.handleInput(Buffer.from("a\x1b[24~"));
      expect(sent).toEqual(["a"]);
      expect(text()).toContain("TOKIMEKI VIEWER CONFIG (SECRET)");
      expect(text()).toContain("token: secret");

      viewport.handleInput(Buffer.from("c"));
      expect(sent).toEqual(["a"]);
      expect(text()).toContain("\x1b]52;c;");

      viewport.handleInput(Buffer.from("\x1b"));
      viewport.handleInput(Buffer.from("b"));
      expect(sent).toEqual(["a", "b"]);
    } finally {
      viewport.restoreSync();
      mirror.dispose();
    }
  });
});
