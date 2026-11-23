/**
 * TUI window policy.
 *
 * `TOKIMEKI_WINDOW_TUI` is both the dynamic subcommand allow-list and the
 * per-command window selector. Matching is by executable basename so
 * `tokimeki run -- /usr/bin/omp` and `tokimeki omp` both resolve to `omp`.
 */

import { ACP_COMMANDS } from "./acp/catalog.js";

export const WINDOW_MODES = ["tui", "on", "off"] as const;
export type WindowMode = (typeof WINDOW_MODES)[number];

/**
 * Default fixed-window/dynamic-dispatch allow-list, sourced from the built-in
 * ACP catalog (9 entries). An explicit `TOKIMEKI_WINDOW_TUI` still replaces it.
 */
export const DEFAULT_TUI_COMMANDS = ACP_COMMANDS;

const WINDOWS_EXECUTABLE_SUFFIX = /\.(?:exe|cmd|bat|com)$/i;

/** Normalize a command or list entry to a comparable basename. */
export function commandBasename(command: string, _platform?: NodeJS.Platform): string {
  const trimmed = command.trim();
  const lastSeparator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = lastSeparator >= 0 ? trimmed.slice(lastSeparator + 1) : trimmed;
  return base.replace(WINDOWS_EXECUTABLE_SUFFIX, "").toLowerCase();
}

/**
 * Parse the comma-separated TUI command list.
 *
 * `undefined` uses the 9-command ACP catalog default; an explicit empty string means
 * "no dynamic TUI commands". Entries are trimmed, lowercased, de-duplicated,
 * and stripped of a Windows executable suffix. Invalid entries simply never
 * match rather than blocking startup.
 */
export function parseTuiCommandList(raw: string | undefined): ReadonlySet<string> {
  const source = raw === undefined ? DEFAULT_TUI_COMMANDS.join(",") : raw;
  const commands = new Set<string>();
  for (const entry of source.split(",")) {
    const normalized = commandBasename(entry);
    if (normalized.length > 0) commands.add(normalized);
  }
  return commands;
}

export interface ResolveWindowModeInput {
  readonly mode: WindowMode;
  readonly tuiCommands: ReadonlySet<string>;
  readonly command: string;
  readonly platform?: NodeJS.Platform;
}

/** True when the hosted command should use the fixed TUI window/viewport. */
export function resolveWindowMode(input: ResolveWindowModeInput): "on" | "off" {
  if (input.mode === "on") return "on";
  if (input.mode === "off") return "off";
  return input.tuiCommands.has(commandBasename(input.command, input.platform)) ? "on" : "off";
}
