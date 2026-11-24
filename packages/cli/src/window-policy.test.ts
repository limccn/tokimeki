import { describe, expect, it } from "vitest";

import { commandBasename, parseTuiCommandList, resolveWindowMode } from "./window-policy.js";

describe("window policy", () => {
  it("normalizes command basenames across separators and Windows suffixes", () => {
    expect(commandBasename("claude")).toBe("claude");
    expect(commandBasename("/usr/local/bin/omp")).toBe("omp");
    expect(commandBasename("C:\\Tools\\OMP.EXE")).toBe("omp");
    expect(commandBasename("C:\\Tools\\omp.cmd")).toBe("omp");
    expect(commandBasename("  /opt/bin/Pi  ")).toBe("pi");
  });

  it("parses the TUI command list with defaults and explicit emptiness", () => {
    expect([...parseTuiCommandList(undefined)]).toEqual([
      "claude",
      "pi",
      "codex",
      "gemini",
      "cursor",
      "aider",
      "opencode",
      "goose",
      "amp",
    ]);
    expect([...parseTuiCommandList("")]).toEqual([]);
    expect([...parseTuiCommandList(" omp, OMP ,, pi.exe ")]).toEqual(["omp", "pi"]);
    expect([...parseTuiCommandList("claude, omp")]).toEqual(["claude", "omp"]);
  });

  it("resolves tui list membership, global on, and global off", () => {
    const tuiCommands = parseTuiCommandList("claude,pi,omp");
    expect(
      resolveWindowMode({ mode: "tui", tuiCommands, command: "/usr/bin/omp", platform: "linux" }),
    ).toBe("on");
    expect(resolveWindowMode({ mode: "tui", tuiCommands, command: "bash" })).toBe("off");
    expect(resolveWindowMode({ mode: "on", tuiCommands: new Set(), command: "bash" })).toBe("on");
    expect(resolveWindowMode({ mode: "off", tuiCommands, command: "omp", platform: "linux" })).toBe(
      "off",
    );
  });
});
