/**
 * Commander wiring for the tokimeki CLI.
 *
 * Only stateless flags (`--help`, `--version`) are accepted locally; every
 * runtime option comes from the environment. `claude`/`pi`/`run` arguments are
 * passed through untouched.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import { Command, CommanderError } from "commander";

import { runAttachSession } from "./attach/attach-session.js";
import { runDoctor } from "./commands/doctor.js";
import {
  type AttachConfig,
  type DoctorConfig,
  type HostConfig,
  loadAttachConfig,
  loadDoctorConfig,
  loadHostConfig,
} from "./config.js";
import { type HostCommandKind, runHostSession } from "./host/host-session.js";
import { buildLocalCommand, isLocalHelpPassthrough } from "./host/pty-command.js";
import { createRedactor, formatError, isLogLevel, Logger, type LogLevel } from "./logger.js";

export interface CliDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly platform?: NodeJS.Platform;
  readonly cwd?: string;
  readonly hostname?: string;
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

function readVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
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
    env.TOKIMEKI_MASTER_TOKEN,
    env.TOKIMEKI_SESSION_TOKEN,
    env.TOKIMEKI_TUNNEL_SECRET,
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
    try {
      config = loadHostConfig({ env, cwd, hostname: deps.hostname });
    } catch (error) {
      printError(error);
      return 2;
    }
    const logger = makeLogger(config.logLevel, config.secrets);
    for (const warning of config.warnings) logger.warn(warning);
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
    try {
      config = loadAttachConfig(env, { listener });
    } catch (error) {
      printError(error);
      return 2;
    }
    const logger = makeLogger(config.logLevel, config.secrets);
    for (const warning of config.warnings) logger.warn(warning);
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
    try {
      config = loadDoctorConfig(env);
    } catch (error) {
      printError(error);
      return 2;
    }
    const logger = makeLogger(readLogLevel(env), config.secrets);
    for (const warning of config.warnings) logger.warn(warning);
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

  const program = new Command();
  program
    .name("tokimeki")
    .description("Share TUI terminal sessions over Cloudflare relay, P2P, or TURN")
    .version(readVersion(), "-V, --version");
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
