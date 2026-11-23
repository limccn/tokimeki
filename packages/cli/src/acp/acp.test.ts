import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ACP_CATALOG } from "./catalog.js";
import { detectAcps, formatAcpList } from "./detect.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokimeki-acp-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("ACP catalog", () => {
  it("contains the nine TokiAPI ACP applications", () => {
    expect(ACP_CATALOG.map((entry) => entry.command)).toEqual([
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
  });

  it("formats a non-detect table", () => {
    const output = formatAcpList([], { detect: false });
    expect(output).toContain("claude");
    expect(output).toContain("default TOKIMEKI_WINDOW_TUI:");
  });
});

describe("read-only PATH detection", () => {
  it("finds executable files on POSIX-style PATHs", () => {
    const dir = tempDir();
    const executable = join(dir, "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    const detection = detectAcps({
      env: { PATH: dir },
      platform: "linux",
      cwd: dir,
    });
    const codex = detection.find((entry) => entry.id === "codex");
    expect(codex?.installed).toBe(true);
    expect(codex?.path).toBe(executable);
    expect(detection.find((entry) => entry.id === "claude")?.installed).toBe(false);
  });

  const posixOnly = process.platform === "win32" ? it.skip : it;
  posixOnly("does not report non-executable files on POSIX", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "claude"), "not executable");
    chmodSync(join(dir, "claude"), 0o644);
    const detection = detectAcps({ env: { PATH: dir }, platform: "linux", cwd: dir });
    expect(detection.find((entry) => entry.id === "claude")?.installed).toBe(false);
  });

  it("honors PATHEXT on Windows-style PATHs and matches aliases", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "gemini.CMD"), "@echo off\r\n");
    writeFileSync(join(dir, "cursor-agent.CMD"), "@echo off\r\n");
    const detection = detectAcps({
      env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      platform: "win32",
      cwd: dir,
    });
    expect(detection.find((entry) => entry.id === "gemini")?.installed).toBe(true);
    expect(detection.find((entry) => entry.id === "cursor")?.installed).toBe(true);
  });

  it("handles empty, duplicate, and relative PATH entries", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "goose"), "");
    chmodSync(join(dir, "goose"), 0o755);
    const detection = detectAcps({
      env: { PATH: `;${dir};${dir};missing` },
      platform: "linux",
      cwd: dir,
    });
    expect(detection.find((entry) => entry.id === "goose")?.installed).toBe(true);
  });

  it("formats detected/missing rows without claiming verification", () => {
    const output = formatAcpList(detectAcps({ env: { PATH: "" }, platform: "linux", cwd: "/" }), {
      detect: true,
    });
    expect(output).toContain("not found in PATH");
    expect(output).toContain("not that it is verified");
  });
});
