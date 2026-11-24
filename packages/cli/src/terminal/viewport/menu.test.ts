import { describe, expect, it } from "vitest";

import { type MenuAction, MenuController, type SpecialKey } from "./menu.js";

const decoder = new TextDecoder();

function controller(
  options: {
    key?: "f12" | "ctrl-]";
    menuEnabled?: boolean;
    resize?: { cols: number; rows: number; policy: string };
    items?: Array<{ id: string; label: string }>;
  } = {},
) {
  const actions: MenuAction[] = [];
  const reveals: boolean[] = [];
  const model = new MenuController({
    key: options.key ?? "f12",
    menuEnabled: options.menuEnabled,
    getModel: ({ revealToken }) => {
      reveals.push(revealToken);
      return {
        title: "TOKIMEKI CONNECTION",
        lines: [`token: ${revealToken ? "secret-value" : "secr…alue"}`],
        items: options.items ?? [
          { id: "status", label: "Refresh" },
          { id: "show-token", label: "Show token" },
          { id: "copy-config", label: "Copy config" },
          { id: "copy-invite", label: "Copy invite" },
          { id: "reconnect", label: "Reconnect" },
          { id: "disconnect", label: "Disconnect" },
          { id: "resize", label: "Resize" },
          { id: "open-logs", label: "Logs" },
        ],
      };
    },
    onAction: (action) => actions.push(action),
    ...(options.resize === undefined ? {} : { resize: options.resize }),
  });
  return { model, actions, reveals };
}

describe("MenuController", () => {
  it("opens with F12, consumes modal input, and forwards pre-trigger bytes", () => {
    const { model, actions } = controller();
    const result = model.handle(Buffer.from("ab\x1b[24~xy"));
    expect(decoder.decode(result.remaining)).toBe("ab");
    expect(result.open).toBe(true);
    expect(model.lines().join("\n")).toContain("TOKIMEKI CONNECTION");
    expect(model.lines().join("\n")).toContain("secr…alue");

    model.handle(Buffer.from("s"));
    expect(model.revealToken).toBe(true);
    expect(model.lines().join("\n")).toContain("secret-value");

    model.handle(Buffer.from("c"));
    model.handle(Buffer.from("3"));
    model.handle(Buffer.from("4"));
    model.handle(Buffer.from("5"));
    model.handle(Buffer.from("6"));
    expect(actions).toEqual([
      { type: "copy-config" },
      { type: "copy-config" },
      { type: "copy-invite" },
      { type: "reconnect" },
      { type: "disconnect" },
    ]);
  });

  it("closes on Esc and resumes forwarding", () => {
    const { model } = controller();
    model.handle(Buffer.from("\x1b[24~"));
    expect(model.open).toBe(true);
    const closed = model.handle(Buffer.from("\x1b"));
    expect(closed.open).toBe(false);
    const resumed = model.handle(Buffer.from("x"));
    expect(decoder.decode(resumed.remaining)).toBe("x");
  });

  it("routes F11 as a log toggle and consumes bytes after it", () => {
    const { model } = controller();
    const result = model.handle(Buffer.from("a\x1b[23~b"));
    expect(decoder.decode(result.remaining)).toBe("a");
    expect(result.logToggle).toBe(true);
    expect(result.open).toBe(false);
  });

  it("supports the ctrl-] trigger and passes F12 through in that mode", () => {
    const { model } = controller({ key: "ctrl-]" });
    const opened = model.handle(Buffer.from([0x1d]));
    expect(opened.open).toBe(true);
    expect(decoder.decode(opened.remaining)).toBe("");
    model.handle(Buffer.from([0x1d]));
    expect(model.open).toBe(false);

    const f12 = controller({ key: "ctrl-]" });
    const passthrough = f12.model.handle(Buffer.from("\x1b[24~"));
    expect(passthrough.open).toBe(false);
    expect(decoder.decode(passthrough.remaining)).toBe("\x1b[24~");
  });

  it("only routes F11 when the menu is disabled", () => {
    const { model } = controller({ menuEnabled: false });
    const f12 = model.handle(Buffer.from("\x1b[24~"));
    expect(f12.open).toBe(false);
    expect(decoder.decode(f12.remaining)).toBe("\x1b[24~");
    const f11 = model.handle(Buffer.from("\x1b[23~"));
    expect(f11.logToggle).toBe(true);
  });

  it("edits a resize value with arrows and applies on Enter", () => {
    const { model, actions } = controller({
      resize: { cols: 100, rows: 30, policy: "latest" },
    });
    model.handle(Buffer.from("\x1b[24~"));
    model.handle(Buffer.from("7")); // resize item
    expect(model.editingResize).toBe(true);
    expect(model.lines().join("\n")).toContain("100 x 30");
    model.handle(Buffer.from("\x1b[C")); // right +1
    model.handle(Buffer.from("\x1b[A")); // up +1
    model.handle(Buffer.from("\x1b[6~")); // pgdn -10 rows
    const applied = model.handle(Buffer.from("\r"));
    expect(applied.open).toBe(false);
    expect(actions).toEqual([{ type: "resize", cols: 101, rows: 21 }]);
  });

  it("cancels the resize editor without closing the menu on Esc", () => {
    const { model } = controller({
      resize: { cols: 80, rows: 24, policy: "min" },
    });
    model.handle(Buffer.from("\x1b[24~"));
    model.handle(Buffer.from("7"));
    const cancelled = model.handle(Buffer.from("\x1b"));
    expect(cancelled.open).toBe(true);
    expect(model.editingResize).toBe(false);
  });

  it("buffers a split F12 sequence across chunks", () => {
    const { model } = controller();
    const first = model.handle(Buffer.from("a\x1b[2"));
    expect(first.open).toBe(false);
    expect(decoder.decode(first.remaining)).toBe("a");
    expect(model.hasPending).toBe(true);
    const second = model.handle(Buffer.from("4~"));
    expect(second.open).toBe(true);
  });

  it("exposes the special-key router for the log view", async () => {
    const { scanSpecialKeys } = await import("./menu.js");
    const parsed = scanSpecialKeys(Buffer.from("\x1b[A\x1b[23~"));
    expect(parsed.keys).toEqual(["up", "f11"] as SpecialKey[]);
  });
});
