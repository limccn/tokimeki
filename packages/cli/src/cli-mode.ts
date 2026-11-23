/**
 * CLI interaction mode (`interactive` vs `daemon`).
 *
 * Mode only changes the local interaction layer: it never touches relay auth,
 * the wire protocol, or the persisted configuration. `--interactive` /
 * `--daemon` are *top-level* global flags (`tokimeki --daemon attach`);
 * flags after a hosted TUI command are passed through untouched.
 */

import { ConfigError } from "./config.js";

export type CliMode = "interactive" | "daemon";

export interface CliModeInput {
  /** stdin is the primary signal: `tokimeki ... | tee` stays interactive. */
  readonly isTTY: boolean;
  readonly interactiveFlag?: boolean;
  readonly daemonFlag?: boolean;
  readonly envMode?: string;
}

export interface GlobalFlags {
  readonly interactive?: boolean;
  readonly daemon?: boolean;
  readonly configPath?: string;
  /** Remaining argv (without the top-level global flags). */
  readonly rest: readonly string[];
}

/**
 * Parse only the global flags that appear before the first command.
 *
 * `tokimeki claude --daemon` must leave `--daemon` for the hosted TUI, so the
 * scan stops at the first non-flag token. `--` also ends global parsing.
 */
export function parseGlobalFlags(argv: readonly string[]): GlobalFlags {
  let interactive: boolean | undefined;
  let daemon: boolean | undefined;
  let configPath: string | undefined;
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index] ?? "";
    if (arg === "--") break;
    if (arg === "--interactive") {
      interactive = true;
      index += 1;
      continue;
    }
    if (arg === "--daemon") {
      daemon = true;
      index += 1;
      continue;
    }
    if (arg === "--config") {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0) {
        throw new ConfigError("--config requires a file path");
      }
      configPath = value;
      index += 2;
      continue;
    }
    if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (value.length === 0) {
        throw new ConfigError("--config requires a file path");
      }
      configPath = value;
      index += 1;
      continue;
    }
    break;
  }
  return {
    ...(interactive === undefined ? {} : { interactive }),
    ...(daemon === undefined ? {} : { daemon }),
    ...(configPath === undefined ? {} : { configPath }),
    rest: argv.slice(index),
  };
}

export function resolveCliMode(input: CliModeInput): CliMode {
  if (input.interactiveFlag === true && input.daemonFlag === true) {
    throw new ConfigError("--interactive and --daemon cannot be used together");
  }
  let mode: CliMode;
  if (input.interactiveFlag === true) {
    mode = "interactive";
  } else if (input.daemonFlag === true) {
    mode = "daemon";
  } else if (input.envMode !== undefined && input.envMode.length > 0) {
    if (input.envMode !== "interactive" && input.envMode !== "daemon") {
      throw new ConfigError(
        `TOKIMEKI_MODE must be one of interactive, daemon (received ${JSON.stringify(input.envMode)})`,
      );
    }
    mode = input.envMode;
  } else {
    mode = input.isTTY ? "interactive" : "daemon";
  }
  if (mode === "interactive" && !input.isTTY) {
    throw new ConfigError(
      "interactive mode requires a TTY on stdin; use --daemon or unset the TTY-only flags",
    );
  }
  return mode;
}
