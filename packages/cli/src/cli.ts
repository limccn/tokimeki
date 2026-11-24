/**
 * Commander wiring for the tokimeki CLI.
 *
 * Runtime options come from the environment; only a few top-level global flags
 * (`--interactive`, `--daemon`, `--config`) and stateless help/version flags are
 * accepted. `claude`/`pi`/`run` arguments (and everything after a hosted TUI
 * command) are passed through untouched.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import { Command, CommanderError } from "commander";

import { detectAcps, formatAcpList } from "./acp/detect.js";
import { runAttachSession } from "./attach/attach-session.js";
import { type CliMode, parseGlobalFlags, resolveCliMode } from "./cli-mode.js";
import { readCliVersion } from "./client-info.js";
import { runDoctor } from "./commands/doctor.js";
import {
  type AttachConfig,
  ConfigError,
  type DoctorConfig,
  type HostConfig,
  loadAttachConfig,
  loadDoctorConfig,
  loadHostConfig,
} from "./config.js";
import { resolveConfigEnv } from "./config-file.js";
import { runDoctorGate } from "./doctor-gate.js";
import { type CliEventErrorCode, type CliEventWriter, createCliEventWriter } from "./events.js";
import { type HostCommandKind, runHostSession } from "./host/host-session.js";
import { buildLocalCommand, isLocalHelpPassthrough } from "./host/pty-command.js";
import { createRedactor, formatError, isLogLevel, Logger, type LogLevel } from "./logger.js";
import { parseAttachUrl } from "./onboarding/attach-url.js";
import {
  type AttachWizardDeps,
  type AttachWizardResult,
  runAttachWizard,
} from "./onboarding/attach-wizard.js";
import {
  type HostWizardDeps,
  type HostWizardResult,
  runHostWizard,
} from "./onboarding/host-wizard.js";
import { createPrompt, type PromptIO, UserAbortError } from "./onboarding/prompt.js";
import {
  DEFAULT_HOSTED_RELAY_URL,
  DEFAULT_TOKIAPI_ORIGIN,
  exchangeAttachCode,
  getPublicConfig,
  normalizeProviderOrigin,
  type TokiApiError,
  TokiApiError as TokiApiErrorClass,
  validateProviderRelayUrl,
} from "./onboarding/tokiapi.js";
import { clearHistory, readHistory, removeHistoryEntry } from "./persist.js";
import { commandBasename, parseTuiCommandList } from "./window-policy.js";

export interface AttachRunHooks {
  readonly onWelcome: () => void;
  readonly mode: CliMode;
  readonly events: CliEventWriter;
}

export interface DoctorRunHooks {
  readonly onReport?: (report: {
    ok: boolean;
    checks: readonly { name: string; status: "ok" | "warn" | "fail"; message?: string }[];
  }) => void;
}

export interface CliDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly platform?: NodeJS.Platform;
  readonly cwd?: string;
  readonly hostname?: string;
  /** Override TTY detection (tests). */
  readonly isTTY?: boolean;
  /** Override the home directory used to locate `~/.tokimeki/`. */
  readonly homeDir?: string;
  readonly fetchImpl?: typeof fetch;
  /** TokiAPI provider base (`https://tokiapi.app` by default; tests/e2e only). */
  readonly tokiapiOrigin?: string;
  readonly createPrompt?: () => PromptIO;
  readonly runHost?: (
    config: HostConfig,
    command: string,
    args: readonly string[],
    kind: HostCommandKind,
    logger: Logger,
  ) => Promise<number>;
  readonly runAttach?: (
    config: AttachConfig,
    logger: Logger,
    hooks?: AttachRunHooks,
  ) => Promise<number>;
  readonly runDoctor?: (
    config: DoctorConfig,
    stdout: NodeJS.WriteStream,
    hooks?: DoctorRunHooks,
  ) => Promise<number>;
  readonly runLocal?: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
  ) => Promise<number>;
  /** Test seams for the interactive onboarding wizards. */
  readonly runHostWizard?: (deps: HostWizardDeps) => Promise<HostWizardResult>;
  readonly runAttachWizard?: (deps: AttachWizardDeps) => Promise<AttachWizardResult>;
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

function mapTokiApiCode(error: TokiApiError): CliEventErrorCode {
  switch (error.kind) {
    case "rate_limited":
      return "rate_limited";
    case "unavailable":
      return "unavailable";
    case "invalid_invite":
      return "config_invalid";
    case "network":
    case "server":
      return "network";
    default:
      return "config_invalid";
  }
}

function isInformational(args: readonly string[]): boolean {
  const first = args[0];
  return first === "--help" || first === "-h" || first === "--version" || first === "-V";
}

async function readLineFromStdin(stdin: NodeJS.ReadStream): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: stdin, terminal: false });
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      rl.close();
    };
    rl.once("line", (line) => {
      finish();
      resolve(line.trim());
    });
    rl.once("close", () => {
      if (!settled) {
        settled = true;
        resolve("");
      }
    });
    rl.once("error", (error) => {
      finish();
      reject(error);
    });
  });
}

export async function main(argv: string[] = process.argv, deps: CliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const platform = deps.platform ?? process.platform;
  const cwd = deps.cwd ?? process.cwd();
  const runLocal = deps.runLocal ?? defaultRunLocal;
  const isTTY = deps.isTTY ?? stdin.isTTY === true;
  const providerOrigin = (() => {
    try {
      return normalizeProviderOrigin(
        deps.tokiapiOrigin ?? env.TOKIMEKI_TOKIAPI_URL ?? DEFAULT_TOKIAPI_ORIGIN,
      );
    } catch {
      return DEFAULT_TOKIAPI_ORIGIN;
    }
  })();

  const knownSecrets = new Set<string>(
    [
      env.TOKIMEKI_TOKEN,
      env.TOKIMEKI_MASTER_TOKEN,
      env.TOKIMEKI_SESSION_TOKEN,
      env.TOKIMEKI_TUNNEL_SECRET,
      env.TOKIMEKI_PASSCODE,
    ].filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  const redactAll = (text: string): string => createRedactor([...knownSecrets])(text);

  let mode: CliMode = "daemon";
  let globalFlags: ReturnType<typeof parseGlobalFlags>;
  const rawArgs = argv.slice(2);
  try {
    globalFlags = parseGlobalFlags(rawArgs);
    mode = isInformational(globalFlags.rest)
      ? "daemon"
      : resolveCliMode({
          isTTY,
          ...(globalFlags.interactive === undefined
            ? {}
            : { interactiveFlag: globalFlags.interactive }),
          ...(globalFlags.daemon === undefined ? {} : { daemonFlag: globalFlags.daemon }),
          ...(env.TOKIMEKI_MODE === undefined ? {} : { envMode: env.TOKIMEKI_MODE }),
        });
  } catch (error) {
    const rawInformational = rawArgs.some(
      (arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V",
    );
    if (rawInformational) {
      globalFlags = { rest: rawArgs };
      mode = "daemon";
    } else {
      try {
        stderr.write(`[tokimeki] error: ${redactAll(formatError(error))}\n`);
      } catch {
        // stderr may be closed
      }
      return 2;
    }
  }
  const userArgs = [...globalFlags.rest];

  const events = createCliEventWriter({
    enabled: mode === "daemon",
    write: (line) => {
      try {
        stderr.write(`${line}\n`);
      } catch {
        // stderr may be closed
      }
    },
    redact: redactAll,
  });

  const printError = (error: unknown): void => {
    try {
      stderr.write(`[tokimeki] error: ${redactAll(formatError(error))}\n`);
    } catch {
      // stderr may be closed
    }
  };
  const fail = (
    error: unknown,
    exitCode: 0 | 1 | 2,
    code: CliEventErrorCode = "unknown",
  ): number => {
    const message = formatError(error);
    printError(error);
    events.error({ code, message, exitCode });
    return exitCode;
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
      redact: createRedactor([...secrets, ...knownSecrets]),
    });
  const makePrompt = (): PromptIO => deps.createPrompt?.() ?? createPrompt({ stdin, stderr });

  // `claude|pi --help/-h/--version` runs locally with no relay configuration.
  // This is handled before Commander parses: its global `--version` option
  // would otherwise swallow `<command> --version` and print the tokimeki
  // version.
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

  // `--config` / TOKIMEKI_CONFIG_FILE are host-only configuration layers.
  const commandName = userArgs[0];
  const existingConfigFile =
    typeof env.TOKIMEKI_CONFIG_FILE === "string" && env.TOKIMEKI_CONFIG_FILE.length > 0
      ? { path: env.TOKIMEKI_CONFIG_FILE, source: "env" as const }
      : undefined;
  const flagConfigFile =
    globalFlags.configPath === undefined
      ? undefined
      : { path: globalFlags.configPath, source: "flag" as const };
  const configFile = flagConfigFile ?? existingConfigFile;
  const nonHostCommands = new Set(["attach", "doctor", "acp", "history"]);
  if (configFile !== undefined && commandName !== undefined && nonHostCommands.has(commandName)) {
    return fail(
      new ConfigError(
        "--config / TOKIMEKI_CONFIG_FILE are only supported for host commands (claude, pi, run, or an ACP command)",
      ),
      2,
      "config_invalid",
    );
  }

  // The config file is read only inside real command actions: a broken file
  // never breaks local `claude|pi --help|--version` passthrough. Test-injected
  // env objects skip ~/.tokimeki/config.json unless a homeDir override opts in.
  const configEnvOptions = {
    homeDir: deps.homeDir,
    platform,
    enabled: deps.env === undefined || deps.homeDir !== undefined,
    ...(configFile === undefined ? {} : { configFile }),
  };

  const SECRET_ENV_KEYS = [
    "TOKIMEKI_TOKEN",
    "TOKIMEKI_MASTER_TOKEN",
    "TOKIMEKI_SESSION_TOKEN",
    "TOKIMEKI_TUNNEL_SECRET",
    "TOKIMEKI_PASSCODE",
  ] as const;
  const applyWizardEnv = (
    base: NodeJS.ProcessEnv,
    overlay: Record<string, string>,
  ): NodeJS.ProcessEnv => {
    for (const key of SECRET_ENV_KEYS) {
      const value = overlay[key];
      if (value !== undefined && value.length > 0) knownSecrets.add(value);
    }
    return { ...base, ...overlay };
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

    let resolved: ReturnType<typeof resolveConfigEnv>;
    try {
      resolved = resolveConfigEnv(env, configEnvOptions);
    } catch (error) {
      return fail(error, 2, "config_invalid");
    }
    let effectiveEnv = resolved.env;
    let inviteUrl: string | undefined;
    let wizardWarnings: readonly string[] = [];

    const gate = runDoctorGate({ command: "host", env: effectiveEnv, mode });
    if (!gate.ok) {
      if (mode === "daemon") {
        const issue = gate.issues[0];
        return fail(
          new ConfigError(issue?.message ?? "host configuration is incomplete"),
          2,
          "config_invalid",
        );
      }
      const prompt = makePrompt();
      try {
        const wizard = deps.runHostWizard ?? runHostWizard;
        const result = await wizard({
          prompt,
          env: effectiveEnv,
          platform,
          ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
          providerOrigin,
        });
        if (result.stopped === true) {
          return 1;
        }
        effectiveEnv = applyWizardEnv(effectiveEnv, result.env);
        inviteUrl = result.inviteUrl;
        wizardWarnings = result.warnings;
      } catch (error) {
        if (error instanceof UserAbortError) {
          try {
            stderr.write("[tokimeki] onboarding cancelled\n");
          } catch {
            // best effort
          }
          return 1;
        }
        return fail(error, error instanceof ConfigError ? 2 : 1, "config_invalid");
      } finally {
        prompt.close();
      }
      const retryGate = runDoctorGate({ command: "host", env: effectiveEnv, mode });
      if (!retryGate.ok) {
        const issue = retryGate.issues[0];
        return fail(
          new ConfigError(issue?.message ?? "host configuration is incomplete"),
          2,
          "config_invalid",
        );
      }
    }

    let config: HostConfig;
    let logger: Logger;
    try {
      config = loadHostConfig({ env: effectiveEnv, cwd, hostname: deps.hostname });
      logger = makeLogger(config.logLevel, config.secrets);
      for (const warning of resolved.warnings) logger.warn(warning);
      for (const warning of wizardWarnings) logger.warn(warning);
      for (const warning of config.warnings) logger.warn(warning);
    } catch (error) {
      return fail(error, 2, "config_invalid");
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
          env: effectiveEnv,
          mode,
          events,
          ...(inviteUrl === undefined ? {} : { hostedInviteUrl: inviteUrl }),
        }));
    try {
      return await runHost(config, baseCommand, args, kind, logger);
    } catch (error) {
      events.error({ code: "unknown", message: formatError(error), exitCode: 1 });
      logger.error(`host session failed: ${formatError(error)}`);
      return 1;
    }
  };

  interface PreparedAttach {
    readonly env: NodeJS.ProcessEnv;
    readonly listener: boolean;
    readonly wizard: AttachWizardResult | null;
  }

  const resolveAttachUrl = async (
    urlOrEnv: string,
    listenerFlag: boolean,
  ): Promise<PreparedAttach> => {
    let raw = urlOrEnv;
    if (raw === "-") {
      raw = await readLineFromStdin(stdin);
      if (raw.length === 0) {
        throw new ConfigError("no share URL was provided on stdin");
      }
    }
    const parsed = parseAttachUrl(raw);
    const tokiApiDeps = deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl };
    const publicConfig = await getPublicConfig(parsed.origin, tokiApiDeps);
    if (!publicConfig.tokimekiEnabled) {
      throw new TokiApiErrorClass(
        "unavailable",
        "TokiAPI hosting is disabled (tokimekiEnabled=false)",
      );
    }
    const grant = await exchangeAttachCode(parsed.origin, parsed.code, tokiApiDeps);
    let relayUrl: string;
    if (publicConfig.tokimekiRelayUrl !== null) {
      relayUrl = validateProviderRelayUrl(publicConfig.tokimekiRelayUrl, parsed.origin);
    } else if (new URL(parsed.origin).hostname.toLowerCase() === "tokiapi.app") {
      relayUrl = DEFAULT_HOSTED_RELAY_URL;
    } else {
      throw new TokiApiErrorClass(
        "schema",
        "the provider did not return tokimekiRelayUrl; refusing to guess a relay",
      );
    }
    let listener: boolean;
    if (grant.mode === "listener") {
      listener = true;
      if (!listenerFlag) {
        try {
          stderr.write("[tokimeki] this invite is read-only; attaching as a listener\n");
        } catch {
          // best effort
        }
      }
    } else {
      if (listenerFlag) {
        throw new ConfigError("this invite is a viewer invite; remove --listen");
      }
      listener = false;
    }
    let passcode = env.TOKIMEKI_PASSCODE;
    if (grant.passcodeRequired && (passcode === undefined || passcode.length === 0)) {
      if (mode === "daemon") {
        throw new ConfigError("TOKIMEKI_PASSCODE is required for this session");
      }
      const prompt = makePrompt();
      try {
        passcode = await prompt.secret({ message: "Session passcode (hidden): " });
      } finally {
        prompt.close();
      }
      if (passcode.length === 0) {
        throw new ConfigError("this session requires a passcode");
      }
    }
    const overlay: Record<string, string> = {
      TOKIMEKI_RELAY_URL: relayUrl,
      TOKIMEKI_SESSION: grant.session,
      TOKIMEKI_SESSION_TOKEN: grant.token,
      ...(passcode === undefined || passcode.length === 0 ? {} : { TOKIMEKI_PASSCODE: passcode }),
    };
    return {
      env: applyWizardEnv({ ...env, ...resolvedBaseEnv }, overlay),
      listener,
      wizard: null,
    };
  };

  // Resolved lazily by attachAction; kept here for URL attach overlays.
  let resolvedBaseEnv: NodeJS.ProcessEnv = env;

  const attachAction = async (listenerFlag: boolean, urlArg?: string): Promise<number> => {
    let resolved: ReturnType<typeof resolveConfigEnv>;
    try {
      resolved = resolveConfigEnv(env, configEnvOptions);
    } catch (error) {
      return fail(error, 2, "config_invalid");
    }
    resolvedBaseEnv = resolved.env;
    let effectiveEnv = resolved.env;
    let listener = listenerFlag;
    let wizard: AttachWizardResult | null = null;

    const attachUrl = urlArg ?? env.TOKIMEKI_ATTACH_URL;
    if (attachUrl !== undefined && attachUrl.length > 0) {
      try {
        const prepared = await resolveAttachUrl(attachUrl, listenerFlag);
        effectiveEnv = prepared.env;
        listener = prepared.listener;
      } catch (error) {
        if (error instanceof TokiApiErrorClass) {
          return fail(error, 1, mapTokiApiCode(error));
        }
        return fail(error, error instanceof ConfigError ? 2 : 1, "config_invalid");
      }
    } else {
      const gate = runDoctorGate({ command: "attach", env: effectiveEnv, mode });
      if (!gate.ok) {
        if (mode === "daemon") {
          const issue = gate.issues[0];
          return fail(
            new ConfigError(issue?.message ?? "attach configuration is incomplete"),
            2,
            "config_invalid",
          );
        }
        const prompt = makePrompt();
        try {
          const wizardRunner = deps.runAttachWizard ?? runAttachWizard;
          wizard = await wizardRunner({
            prompt,
            env: effectiveEnv,
            listener: listenerFlag,
            homeDir: deps.homeDir,
            platform,
            ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
            providerOrigin,
          });
          effectiveEnv = applyWizardEnv(effectiveEnv, wizard.env);
          listener = wizard.listener;
        } catch (error) {
          if (error instanceof UserAbortError) {
            try {
              stderr.write("[tokimeki] onboarding cancelled\n");
            } catch {
              // best effort
            }
            return 1;
          }
          return fail(error, error instanceof ConfigError ? 2 : 1, "config_invalid");
        } finally {
          prompt.close();
        }
        const retryGate = runDoctorGate({ command: "attach", env: effectiveEnv, mode });
        if (!retryGate.ok) {
          const issue = retryGate.issues[0];
          return fail(
            new ConfigError(issue?.message ?? "attach configuration is incomplete"),
            2,
            "config_invalid",
          );
        }
      }
    }

    let config: AttachConfig;
    let logger: Logger;
    try {
      config = loadAttachConfig(effectiveEnv, { listener });
      logger = makeLogger(config.logLevel, config.secrets);
      for (const warning of resolved.warnings) logger.warn(warning);
      for (const warning of wizard?.warnings ?? []) logger.warn(warning);
      for (const warning of config.warnings) logger.warn(warning);
    } catch (error) {
      return fail(error, 2, "config_invalid");
    }
    const runAttach =
      deps.runAttach ??
      ((attachConfig, attachLogger, hooks) =>
        runAttachSession(attachConfig, {
          logger: attachLogger,
          stdin,
          stdout,
          stderr,
          platform,
          mode,
          events,
          ...(hooks === undefined ? {} : { onWelcome: hooks.onWelcome }),
        }));
    // Retry/re-enter is only an onboarding affordance. A complete env/config
    // attach (or share-URL attach) exits with the failure instead of prompting.
    const prompt =
      wizard !== null && mode === "interactive" && deps.runAttach === undefined
        ? makePrompt()
        : null;
    try {
      for (;;) {
        let welcomed = false;
        let code: number;
        try {
          code = await runAttach(config, logger, {
            onWelcome: () => {
              welcomed = true;
            },
            mode,
            events,
          });
        } catch (error) {
          events.error({ code: "unknown", message: formatError(error), exitCode: 1 });
          logger.error(`attach session failed: ${formatError(error)}`);
          return 1;
        }
        if (welcomed) {
          if (wizard !== null && wizard.finalize !== null) {
            const warnings = await wizard.finalize();
            for (const warning of warnings) logger.warn(warning);
          }
          return code;
        }
        if (code === 0) return 0;
        if (prompt === null) return code;
        const action = await prompt.select({
          message: "The connection test failed before the session was ready.",
          choices: [
            { label: "Retry with the same settings", value: "retry" },
            { label: "Re-enter the connection settings", value: "reenter" },
            { label: "Quit", value: "quit" },
          ],
          defaultIndex: 0,
        });
        if (action === "quit") return code;
        if (action === "reenter") {
          try {
            const wizardRunner = deps.runAttachWizard ?? runAttachWizard;
            const next = await wizardRunner({
              prompt,
              env: effectiveEnv,
              listener,
              homeDir: deps.homeDir,
              platform,
              ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
              providerOrigin,
            });
            wizard = next;
            effectiveEnv = applyWizardEnv(effectiveEnv, next.env);
            listener = next.listener;
            config = loadAttachConfig(effectiveEnv, { listener });
            logger = makeLogger(config.logLevel, config.secrets);
          } catch (error) {
            if (error instanceof UserAbortError) return 1;
            return fail(error, error instanceof ConfigError ? 2 : 1, "config_invalid");
          }
        }
      }
    } finally {
      prompt?.close();
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
      return fail(error, 2, "config_invalid");
    }
    const runDoctorCommand =
      deps.runDoctor ??
      ((doctorConfig, reportStream, hooks) =>
        runDoctor(doctorConfig, {
          stdout: reportStream,
          ...(hooks?.onReport === undefined ? {} : { onReport: hooks.onReport }),
        }));
    try {
      return await runDoctorCommand(config, stdout, {
        onReport: (report) => {
          events.report(report);
        },
      });
    } catch (error) {
      events.error({ code: "unknown", message: formatError(error), exitCode: 1 });
      logger.error(`doctor failed: ${formatError(error)}`);
      return 1;
    }
  };

  const acpAction = async (detect: boolean): Promise<number> => {
    try {
      const detection = detectAcps({ env, platform, cwd });
      const output = formatAcpList(detection, { detect });
      stdout.write(`${output}\n`);
      return 0;
    } catch (error) {
      return fail(error, 1, "unknown");
    }
  };

  const historyAction = async (
    action: string | undefined,
    session: string | undefined,
  ): Promise<number> => {
    try {
      if (action === "clear") {
        const result = clearHistory({ homeDir: deps.homeDir, platform });
        stdout.write(`cleared ${result.path}\n`);
        return 0;
      }
      if (action === "remove") {
        if (session === undefined || session.length === 0) {
          printError(new ConfigError("history remove requires a session name"));
          return 2;
        }
        const result = removeHistoryEntry(session, { homeDir: deps.homeDir, platform });
        stdout.write(`updated ${result.path}\n`);
        return 0;
      }
      if (action !== undefined && action !== "list") {
        printError(new ConfigError("history supports list, remove <session>, or clear"));
        return 2;
      }
      const history = readHistory({ homeDir: deps.homeDir, platform });
      if (history.entries.length === 0) {
        stdout.write("no saved connections\n");
        return 0;
      }
      for (const entry of history.entries) {
        const when = new Date(entry.lastUsedAt).toISOString();
        const token = entry.sessionToken === undefined ? "no-token" : "token-saved";
        stdout.write(
          `${entry.session}  relay=${entry.relayUrl}  ${entry.namespace === undefined ? "" : `namespace=${entry.namespace}  `}lastUsedAt=${when}  ${token}\n`,
        );
      }
      return 0;
    } catch (error) {
      return fail(error, 2, "config_invalid");
    }
  };

  // Dynamic TUI subcommands: any non-option first arg whose basename is in the
  // ACP allow-list (TOKIMEKI_WINDOW_TUI or the built-in 9-command default) is
  // hosted directly. The list is also the allow-list: unknown commands never
  // spawn anything implicitly.
  const knownCommands = new Set([
    "claude",
    "pi",
    "run",
    "attach",
    "doctor",
    "acp",
    "history",
    "help",
  ]);
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
    return fail(
      new Error(
        `unknown command: ${dynamicCommand}; use "tokimeki run -- ${dynamicCommand}" ` +
          `or add "${base}" to TOKIMEKI_WINDOW_TUI`,
      ),
      1,
      "unknown",
    );
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
  program.addHelpText(
    "after",
    [
      "",
      "Global options (before the command):",
      "  --interactive           force interactive onboarding (TTY required)",
      "  --daemon                force daemon/harness mode (no prompts)",
      "  --config <file>         host from a TokiAPI tokimeki-config.json envelope",
      "",
      "ACP commands: tokimeki <acp> (claude, pi, codex, gemini, cursor, aider,",
      "  opencode, goose, amp) or tokimeki run -- <cmd>; see: tokimeki acp list",
      "Attach from a TokiAPI share URL: tokimeki attach https://<origin>/#t-<code>",
    ].join("\n"),
  );

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
    .argument("[url]", "TokiAPI share URL (https://<origin>/#t-<code>)")
    .option("--listen", "attach as a read-only listener (snapshot-only)")
    .action(async (url: string | undefined, options: { listen?: boolean }) => {
      exitCode = await attachAction(options.listen === true, url);
    });

  program
    .command("doctor")
    .description("Check configuration, PTY support, and relay reachability")
    .action(async () => {
      exitCode = await doctorAction();
    });

  const acpProgram = program.command("acp").description("ACP application catalog and detection");
  acpProgram
    .command("list")
    .description("List the built-in ACP catalog")
    .option("--detect", "read-only PATH detection (never executes a binary)")
    .action(async (options: { detect?: boolean }) => {
      exitCode = await acpAction(options.detect === true);
    });

  program
    .command("history")
    .description("Inspect or clear saved connection history")
    .argument("[action]", "list (default), remove, or clear")
    .argument("[session]", "session name for `remove`")
    .action(async (action: string | undefined, session: string | undefined) => {
      exitCode = await historyAction(action, session);
    });

  try {
    await program.parseAsync([argv[0] ?? "node", argv[1] ?? "tokimeki", ...userArgs]);
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    printError(error);
    return 1;
  }
  return exitCode;
}
