/**
 * Commander wiring for the tokimeki CLI.
 *
 * Only stateless flags (`--help`, `--version`) are accepted locally; every
 * runtime option comes from the environment. `claude`/`pi`/`run` arguments are
 * passed through untouched.
 */

import { spawn } from "node:child_process";

import { Command, CommanderError } from "commander";

import { runAttachSession } from "./attach/attach-session.js";
import { readCliVersion } from "./client-info.js";
import { runDoctor } from "./commands/doctor.js";
import {
  type AttachConfig,
  type DoctorConfig,
  type HostConfig,
  loadAttachConfig,
  loadDoctorConfig,
  loadHostConfig,
} from "./config.js";
import { resolveConfigEnv } from "./config-file.js";
import { type HostCommandKind, runHostSession } from "./host/host-session.js";
import { buildLocalCommand, isLocalHelpPassthrough } from "./host/pty-command.js";
import { createRedactor, formatError, isLogLevel, Logger, type LogLevel } from "./logger.js";
import { commandBasename, parseTuiCommandList } from "./window-policy.js";

export interface CliDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly platform?: NodeJS.Platform;
  readonly cwd?: string;
  readonly hostname?: string;
  /** Override the home directory used to locate `~/.tokimeki/config.json`. */
  readonly homeDir?: string;
  readonly runHost?: (
    config: HostConfig,
    command: string,
    args: readonly string[],
    kind: HostCommandKind,
    logger: Logger,
  ) => Promise<number>;
  readonly runAttach?: (config: AttachConfig, logger: Logger) => Promise<number>;
  readonly runDoctor?: (config: DoctorConfig, stdout: NodeJS.WriteStream) => Promise<number>;
  readonly runLocal?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
  ) => Promise<number>;
}

function defaultRunLocal(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<number> {
  const spec = buildLocalCommand(command, args, { env, platform });
  return new Promise<number>((resolve) => {
    const child = spawn(spec.command, [...spec.args], {
      stdio: "inherit",
      env,
      windowsHide: false,
    });
    child.on("error", (error) => {
      try {
        process.stderr.write(`[tokimeki] error: failed to run ${command}: ${error.message}\n`);
      } catch {
        // best effort
      }
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      resolve(code ?? (signal === null ? 0 : 1));
    });
  });
}

function readLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = env.TOKIMEKI_LOG_LEVEL;
  return raw !== undefined && isLogLevel(raw) ? raw : "info";
}

export async function main(argv: string[] = process.argv, deps: CliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const platform = deps.platform ?? process.platform;
  const cwd = deps.cwd ?? process.cwd();
  const runLocal = deps.runLocal ?? defaultRunLocal;
  const bootstrapRedact = createRedactor([
    env.TOKIMEKI_TOKEN,
    env.TOKIMEKI_MASTER_TOKEN,
    env.TOKIMEKI_SESSION_TOKEN,
    env.TOKIMEKI_TUNNEL_SECRET,
    env.TOKIMEKI_PASSCODE,
  ]);

  const printError = (error: unknown): void => {
    try {
      stderr.write(`[tokimeki] error: ${bootstrapRedact(formatError(error))}\n`);
    } catch {
      // stderr may be closed
    }
  };
  const makeLogger = (level: LogLevel, secrets: readonly string[]): Logger =>
    new Logger({
      level,
      write: (line) => {
        try {
          stderr.write(`${line}\n`);
        } catch {
          // stderr may be closed
        }
      },
      redact: createRedactor(secrets),
    });

  // `claude|pi --help/-h/--version` runs locally with no relay configuration.
  // This is handled before Commander parses: its global `--version` option
  // would otherwise swallow `<command> --version` and print the tokimeki
  // version.
  const userArgs = argv.slice(2);
  const firstCommand = userArgs[0];
  if (
    (firstCommand === "claude" || firstCommand === "pi") &&
    isLocalHelpPassthrough(userArgs.slice(1))
  ) {
    try {
      return await runLocal(firstCommand, userArgs.slice(1), env, platform);
    } catch (error) {
      printError(error);
      return 1;
    }
  }

  // The config file is read only inside real command actions: a broken file
  // never breaks local `claude|pi --help|--version` passthrough. Test-injected
  // env objects skip the file unless a homeDir override opts in.
  const configEnvOptions = {
    homeDir: deps.homeDir,
    platform,
    enabled: deps.env === undefined || deps.homeDir !== undefined,
  };

  const hostAction = async (
    kind: HostCommandKind,
    baseCommand: string,
    args: readonly string[],
  ): Promise<number> => {
    // claude|pi --help/-h/--version must work without relay configuration.
    if ((kind === "claude" || kind === "pi") && isLocalHelpPassthrough(args)) {
      try {
        return await runLocal(baseCommand, args, env, platform);
      } catch (error) {
        printError(error);
        return 1;
      }
    }

    let config: HostConfig;
    let logger: Logger;
    try {
      const resolved = resolveConfigEnv(env, configEnvOptions);
      config = loadHostConfig({ env: resolved.env, cwd, hostname: deps.hostname });
      logger = makeLogger(config.logLevel, config.secrets);
      for (const warning of resolved.warnings) logger.warn(warning);
      for (const warning of config.warnings) logger.warn(warning);
    } catch (error) {
      printError(error);
      return 2;
    }
    if (kind === "claude" && config.claudeBg) {
      logger.warn(
        "TOKIMEKI_CLAUDE_BG is experimental and is not implemented in v1; starting claude normally",
      );
    }
    const runHost =
      deps.runHost ??
      ((hostConfig, command, commandArgs, commandKind, hostLogger) =>
        runHostSession(hostConfig, command, commandArgs, commandKind, {
          logger: hostLogger,
          stdin,
          stdout,
          stderr,
          platform,
          cwd,
          env,
        }));
    try {
      return await runHost(config, baseCommand, args, kind, logger);
    } catch (error) {
      logger.error(`host session failed: ${formatError(error)}`);
      return 1;
    }
  };

  const attachAction = async (listener: boolean): Promise<number> => {
    let config: AttachConfig;
    let logger: Logger;
    try {
      const resolved = resolveConfigEnv(env, configEnvOptions);
      config = loadAttachConfig(resolved.env, { listener });
      logger = makeLogger(config.logLevel, config.secrets);
      for (const warning of resolved.warnings) logger.warn(warning);
      for (const warning of config.warnings) logger.warn(warning);
    } catch (error) {
      printError(error);
      return 2;
    }
    const runAttach =
      deps.runAttach ??
      ((attachConfig, attachLogger) =>
        runAttachSession(attachConfig, {
          logger: attachLogger,
          stdin,
          stdout,
          stderr,
          platform,
        }));
    try {
      return await runAttach(config, logger);
    } catch (error) {
      logger.error(`attach session failed: ${formatError(error)}`);
      return 1;
    }
  };

  const doctorAction = async (): Promise<number> => {
    let config: DoctorConfig;
    let logger: Logger;
    try {
      const resolved = resolveConfigEnv(env, configEnvOptions);
      config = loadDoctorConfig(resolved.env, { configFile: resolved.file });
      logger = makeLogger(readLogLevel(resolved.env), config.secrets);
      for (const warning of resolved.warnings) logger.warn(warning);
      for (const warning of config.warnings) logger.warn(warning);
    } catch (error) {
      printError(error);
      return 2;
    }
    const runDoctorCommand =
      deps.runDoctor ??
      ((doctorConfig, reportStream) => runDoctor(doctorConfig, { stdout: reportStream }));
    try {
      return await runDoctorCommand(config, stdout);
    } catch (error) {
      logger.error(`doctor failed: ${formatError(error)}`);
      return 1;
    }
  };

  // Dynamic TUI subcommands: any non-option first arg whose basename is in
  // TOKIMEKI_WINDOW_TUI is hosted directly (e.g. `tokimeki omp`). The list is
  // also the allow-list: unknown commands never spawn anything implicitly.
  const knownCommands = new Set(["claude", "pi", "run", "attach", "doctor", "help"]);
  const dynamicCommand = userArgs[0];
  if (
    dynamicCommand !== undefined &&
    !dynamicCommand.startsWith("-") &&
    !knownCommands.has(dynamicCommand)
  ) {
    const tuiCommands = parseTuiCommandList(env.TOKIMEKI_WINDOW_TUI);
    const base = commandBasename(dynamicCommand, platform);
    if (tuiCommands.has(base)) {
      if (isLocalHelpPassthrough(userArgs.slice(1))) {
        try {
          return await runLocal(dynamicCommand, userArgs.slice(1), env, platform);
        } catch (error) {
          printError(error);
          return 1;
        }
      }
      return await hostAction("custom", dynamicCommand, userArgs.slice(1));
    }
    printError(
      `unknown command: ${dynamicCommand}; use "tokimeki run -- ${dynamicCommand}" ` +
        `or add "${base}" to TOKIMEKI_WINDOW_TUI`,
    );
    return 1;
  }

  const program = new Command();
  program
    .name("tokimeki")
    .description("Share TUI terminal sessions over Cloudflare relay, P2P, or TURN")
    .version(readCliVersion(), "-V, --version");
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => stdout.write(text),
    writeErr: (text) => stderr.write(text),
  });

  let exitCode = 0;

  program
    .command("claude")
    .description("Host the claude CLI in a PTY")
    .helpOption(false)
    .allowUnknownOption(true)
    .argument("[args...]")
    .action(async (args: string[] | undefined) => {
      exitCode = await hostAction("claude", "claude", args ?? []);
    });

  program
    .command("pi")
    .description("Host the pi CLI in a PTY")
    .helpOption(false)
    .allowUnknownOption(true)
    .argument("[args...]")
    .action(async (args: string[] | undefined) => {
      exitCode = await hostAction("pi", "pi", args ?? []);
    });

  program
    .command("run")
    .description("Host an arbitrary command in a PTY (use: run -- <cmd...>)")
    .helpOption(false)
    .allowUnknownOption(true)
    .argument("<cmd...>")
    .action(async (cmd: string[]) => {
      if (cmd.length === 0) {
        printError("run requires a command after --");
        exitCode = 2;
        return;
      }
      const [command, ...args] = cmd;
      if (command === undefined) {
        exitCode = 2;
        return;
      }
      exitCode = await hostAction("run", command, args);
    });

  program
    .command("attach")
    .description("Attach to a hosted session")
    .option("--listen", "attach as a read-only listener (snapshot-only)")
    .action(async (options: { listen?: boolean }) => {
      exitCode = await attachAction(options.listen === true);
    });

  program
    .command("doctor")
    .description("Check configuration, PTY support, and relay reachability")
    .action(async () => {
      exitCode = await doctorAction();
    });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    printError(error);
    return 1;
  }
  return exitCode;
}
