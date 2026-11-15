/**
 * `tokimeki doctor`: environment shape, node-pty capability, relay health.
 *
 * The report is redacted and never contains token values. The command exits
 * non-zero when a required check fails.
 */

import { type DoctorConfig, relayHealthUrl } from "../config.js";
import { createRedactor, formatError } from "../logger.js";

export interface DoctorDeps {
  readonly stdout?: NodeJS.WriteStream;
  readonly fetchImpl?: typeof fetch;
  /** Returns null on success or a human-readable failure reason. */
  readonly probePty?: () => Promise<string | null>;
}

const HEALTH_TIMEOUT_MS = 5_000;

async function probeNodePty(): Promise<string | null> {
  try {
    const loaded = (await import("@homebridge/node-pty-prebuilt-multiarch")) as unknown as {
      spawn?: unknown;
      default?: { spawn?: unknown };
    };
    const api = loaded.default ?? loaded;
    if (typeof api.spawn !== "function") {
      return "node-pty module does not export spawn()";
    }
    const spawn = api.spawn as (
      file: string,
      args: string[] | string,
      options: Record<string, unknown>,
    ) => {
      onExit: (handler: (event: { exitCode: number }) => void) => void;
      kill: () => void;
    };
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
      encoding: null,
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // best effort
        }
        reject(new Error("PTY probe timed out"));
      }, HEALTH_TIMEOUT_MS);
      child.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return null;
  } catch (error) {
    return formatError(error);
  }
}

export async function runDoctor(config: DoctorConfig, deps: DoctorDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const probePty = deps.probePty ?? probeNodePty;
  const redact = createRedactor(config.secrets);
  const lines: string[] = [];
  let failures = 0;

  const write = (line: string): void => {
    lines.push(redact(line));
    try {
      stdout.write(`${redact(line)}\n`);
    } catch {
      // best effort
    }
  };
  const ok = (label: string): void => write(`[ok] ${label}`);
  const warn = (label: string): void => write(`[warn] ${label}`);
  const fail = (label: string): void => {
    failures += 1;
    write(`[fail] ${label}`);
  };

  write("tokimeki doctor");

  if (config.relayUrl === null) {
    fail("TOKIMEKI_RELAY_URL is missing or invalid");
  } else {
    ok(`relay URL: ${config.relayUrl}`);
  }

  if (config.hasMasterToken) {
    ok("host authentication environment is present (TOKIMEKI_MASTER_TOKEN)");
  } else {
    warn("TOKIMEKI_MASTER_TOKEN is not set (required to host a session)");
  }

  const attachComplete = config.session !== null && config.hasSessionToken;
  if (attachComplete) {
    ok("attach environment is present (TOKIMEKI_SESSION, TOKIMEKI_SESSION_TOKEN)");
  } else {
    const missing = [
      ...(config.session === null ? ["TOKIMEKI_SESSION"] : []),
      ...(config.hasSessionToken ? [] : ["TOKIMEKI_SESSION_TOKEN"]),
    ];
    warn(`attach environment is incomplete (missing ${missing.join(", ")})`);
  }

  if (!config.hasMasterToken && !attachComplete) {
    fail("no complete host or attach configuration was found");
  }

  if (config.warnings.length > 0) {
    for (const warning of config.warnings) warn(warning);
  }

  const ptyProblem = await probePty();
  if (ptyProblem === null) {
    ok("node-pty loaded and spawned a PTY process");
  } else {
    fail(`node-pty PTY probe failed: ${ptyProblem}`);
  }

  if (config.relayUrl !== null) {
    const healthUrl = relayHealthUrl(config.relayUrl);
    try {
      const response = await fetchImpl(healthUrl, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (response.ok) {
        ok(`relay healthz reachable (HTTP ${response.status})`);
      } else {
        fail(`relay healthz returned HTTP ${response.status}`);
      }
    } catch (error) {
      fail(`relay healthz unreachable at ${healthUrl}: ${formatError(error)}`);
    }
  }

  if (failures === 0) {
    write("result: all checks passed");
    return 0;
  }
  write(`result: ${failures} check(s) failed`);
  return 1;
}
