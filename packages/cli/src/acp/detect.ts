/**
 * Read-only ACP detection (v1.4-I).
 *
 * Reports only "a same-named executable was found in PATH"; it never executes
 * the binary, asks it for a version, runs a shell, or reads file contents.
 * Unknown TUI commands are not scanned or suggested.
 */

import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { ACP_CATALOG, type AcpEntry } from "./catalog.js";

export interface AcpDetection {
  readonly id: string;
  readonly command: string;
  readonly installed: boolean;
  /** First matching absolute-looking PATH candidate (diagnostic only). */
  readonly path?: string;
}

export interface DetectAcpsOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly cwd?: string;
  readonly catalog?: readonly AcpEntry[];
}

const DEFAULT_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

function pathExtensions(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): readonly string[] {
  if (platform !== "win32") return [""];
  const raw = env.PATHEXT;
  const entries =
    raw === undefined || raw.trim().length === 0
      ? DEFAULT_PATHEXT
      : raw
          .split(";")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
          .map((entry) => (entry.startsWith(".") ? entry : `.${entry}`));
  return entries.length === 0 ? DEFAULT_PATHEXT : entries;
}

function candidateDirectories(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  cwd: string,
): string[] {
  const raw = env.PATH ?? env.Path ?? "";
  // Use the target platform, not the host: tests pass a synthetic platform.
  const separator = platform === "win32" ? ";" : ":";
  const seen = new Set<string>();
  const directories: string[] = [];
  for (const entry of raw.split(separator)) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const directory = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
    if (seen.has(directory)) continue;
    seen.add(directory);
    directories.push(directory);
  }
  return directories;
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return false;
    if (platform !== "win32") {
      accessSync(path, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function findCommand(
  command: string,
  directories: readonly string[],
  extensions: readonly string[],
  platform: NodeJS.Platform,
): string | undefined {
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

export function detectAcps(options: DetectAcpsOptions = {}): readonly AcpDetection[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const catalog = options.catalog ?? ACP_CATALOG;
  const directories = candidateDirectories(env, platform, cwd);
  const extensions = pathExtensions(env, platform);
  return catalog.map((entry) => {
    const primary = findCommand(entry.command, directories, extensions, platform);
    if (primary !== undefined) {
      return { id: entry.id, command: entry.command, installed: true, path: primary };
    }
    for (const alias of entry.aliases ?? []) {
      const match = findCommand(alias, directories, extensions, platform);
      if (match !== undefined) {
        return { id: entry.id, command: entry.command, installed: true, path: match };
      }
    }
    return { id: entry.id, command: entry.command, installed: false };
  });
}

/** Human-readable table used by `tokimeki acp list [--detect]`. */
export function formatAcpList(
  detections: readonly AcpDetection[],
  options: { readonly detect: boolean },
): string {
  const header = options.detect ? "id       command   installed  path" : "id       command   label";
  const lines = [header];
  const byId = new Map(detections.map((entry) => [entry.id, entry]));
  for (const entry of ACP_CATALOG) {
    if (options.detect) {
      const detection = byId.get(entry.id);
      const installed = detection?.installed === true ? "yes" : "no";
      lines.push(
        `${entry.id.padEnd(8)} ${entry.command.padEnd(9)} ${installed.padEnd(10)} ${detection?.path ?? "not found in PATH"}`,
      );
    } else {
      lines.push(`${entry.id.padEnd(8)} ${entry.command.padEnd(9)} ${entry.label}`);
    }
  }
  const names = ACP_CATALOG.map((entry) => entry.command).join(",");
  lines.push("");
  lines.push(`default TOKIMEKI_WINDOW_TUI: ${names}`);
  if (options.detect) {
    lines.push(
      "detection is read-only and diagnostic: a match only means a same-named executable exists in PATH, not that it is verified as that application",
    );
  }
  return lines.join("\n");
}
