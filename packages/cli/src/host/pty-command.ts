/**
 * Command/env resolution for the PTY host.
 *
 * Windows `.cmd` shims (claude, pi, npm-installed binaries) must be launched
 * through `cmd.exe /c`; POSIX commands are spawned directly. Arguments are
 * always passed one-by-one, never concatenated into a shell string.
 */

import type { PiTuiMode } from "../config.js";

export interface PtyCommandSpec {
  /** Executable passed to node-pty (`cmd.exe` on Windows shims). */
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly display: string;
}

export interface BuildPtyCommandOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly term: string;
  readonly colorterm: string;
  readonly piTuiMode: PiTuiMode;
  readonly isClaude: boolean;
  readonly isPi: boolean;
}

const SSH_ENV_VARS = ["SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"] as const;

/**
 * Host-side credentials that must never reach the shared PTY process.
 *
 * Viewers share control of the hosted terminal and can run `env`/`printenv`
 * (directly, or through the hosted agent), so inheriting these values would
 * expose the relay master token, session token, or TURN secrets to every
 * attached viewer.
 */
const HOST_SECRET_ENV_VARS = [
  "TOKIMEKI_TOKEN",
  "TOKIMEKI_MASTER_TOKEN",
  // Relay-side secret map: a self-hoster may run the Worker and the host CLI
  // from the same shell, and this map holds every namespace host token.
  "TOKIMEKI_NAMESPACE_TOKENS",
  "TOKIMEKI_SESSION_TOKEN",
  "TOKIMEKI_TUNNEL_SECRET",
  "TOKIMEKI_PASSCODE",
  "TOKIMEKI_COTURN_SECRET",
  "TOKIMEKI_TURN_API_TOKEN",
  "TOKIMEKI_TURN_CREDENTIAL",
  // The envelope may contain the tokens above; never expose it to the PTY.
  "TOKIMEKI_CONFIG",
] as const;

/**
 * True when the args ask a hosted CLI (claude/pi) for help/version and must
 * run locally instead of opening a relay session.
 */
export function isLocalHelpPassthrough(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version");
}

/** True when the user already chose a pi TUI mode themselves. */
export function hasExplicitPiTuiMode(args: readonly string[]): boolean {
  return args.some((arg) => arg === "--tui-mode" || arg.startsWith("--tui-mode="));
}

export function buildChildEnvironment(options: BuildPtyCommandOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...options.env };
  if (options.platform === "win32") {
    // Windows environment variable names are case-insensitive. Remove every
    // casing variant so a non-canonical secret cannot survive the exact-name
    // `delete` and leak into the shared PTY.
    const blocked = new Set<string>([...SSH_ENV_VARS, ...HOST_SECRET_ENV_VARS]);
    for (const name of Object.keys(env)) {
      if (blocked.has(name.toUpperCase())) {
        delete env[name];
      }
    }
  } else {
    // POSIX names are case-sensitive; only remove the canonical CLI variables
    // so a user's lowercase variable is not deleted unexpectedly.
    for (const name of [...SSH_ENV_VARS, ...HOST_SECRET_ENV_VARS]) {
      delete env[name];
    }
  }
  env.TERM = options.term;
  env.COLORTERM = options.colorterm;
  if (env.LANG === undefined || env.LANG === "") {
    env.LANG = options.platform === "win32" ? "C.UTF-8" : "en_US.UTF-8";
  }
  if (
    options.isClaude &&
    (env.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT === undefined ||
      env.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT === "")
  ) {
    env.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT = "1";
  }
  return env;
}

function isWindowsShellCommand(platform: NodeJS.Platform, command: string): boolean {
  if (platform !== "win32") return false;
  return /\.(cmd|bat)$/i.test(command) || !/\.(exe|com)$/i.test(command);
}

/**
 * Build the node-pty spawn specification.
 *
 * `command` may be a bare program name ("claude", "pi") or a full path. On
 * Windows every non-`.exe`/`.com` target is routed through `cmd.exe /c`, which
 * also covers PATH-resolved `.cmd` shims.
 */
export function buildPtyCommand(
  command: string,
  args: readonly string[],
  options: BuildPtyCommandOptions,
): PtyCommandSpec {
  const env = buildChildEnvironment(options);
  const effectiveArgs = [...args];
  if (options.isPi && options.piTuiMode === "regular" && !hasExplicitPiTuiMode(effectiveArgs)) {
    effectiveArgs.push("--tui-mode", "regular");
  }

  if (isWindowsShellCommand(options.platform, command)) {
    const comspec = options.env.ComSpec ?? options.env.COMSPEC ?? "cmd.exe";
    return {
      command: comspec,
      args: ["/c", command, ...effectiveArgs],
      env,
      display: [command, ...effectiveArgs].join(" "),
    };
  }
  return {
    command,
    args: effectiveArgs,
    env,
    display: [command, ...effectiveArgs].join(" "),
  };
}

/** Spawn specification for running a command locally with inherited stdio. */
export function buildLocalCommand(
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform },
): { command: string; args: readonly string[] } {
  if (isWindowsShellCommand(options.platform, command)) {
    const comspec = options.env.ComSpec ?? options.env.COMSPEC ?? "cmd.exe";
    return { command: comspec, args: ["/c", command, ...args] };
  }
  return { command, args };
}
