/**
 * `tokimeki doctor`: environment shape, node-pty capability, relay health.
 *
 * The report is redacted and never contains token values, header values, or
 * JWKS material. The command exits non-zero when a required check fails.
 */

import { ICE_PROVIDERS } from "@limccn/tokimeki-protocol";
import {
  buildHostAuthHeaders,
  type DoctorConfig,
  HOST_NAMESPACE_PATTERN,
  relayHealthUrl,
  relayWhoamiUrl,
} from "../config.js";
import type { ReportCheck } from "../events.js";
import { createRedactor, formatError } from "../logger.js";

export interface DoctorDeps {
  readonly stdout?: NodeJS.WriteStream;
  readonly fetchImpl?: typeof fetch;
  /** Returns null on success or a human-readable failure reason. */
  readonly probePty?: () => Promise<string | null>;
  /** Structured daemon-mode report (stderr event); the human report is unchanged. */
  readonly onReport?: (report: { ok: boolean; checks: readonly ReportCheck[] }) => void;
}

const HEALTH_TIMEOUT_MS = 5_000;

/**
 * The `/auth/whoami` body is remote input, so only a known provider name is
 * echoed into the report; anything else could smuggle terminal escapes.
 */
function knownIceProvider(value: unknown): string | null {
  return typeof value === "string" && (ICE_PROVIDERS as readonly string[]).includes(value)
    ? value
    : null;
}

type ReportLine = (label: string) => void;

/**
 * Echo only defensive-validated whoami fields into the report.
 *
 * The body is remote input: every echoed value is pattern-checked so terminal
 * escapes cannot be smuggled into the report. Tokens, the request header, and
 * JWKS material are never printed.
 */
function describeWhoami(
  body: Record<string, unknown> | null,
  config: DoctorConfig,
  warn: ReportLine,
  ok: ReportLine,
): void {
  if (body === null || body.authMode === undefined) {
    ok("relay whoami authenticated");
    return;
  }
  const authMode = body.authMode;
  if (authMode !== "jwt" && authMode !== "namespace" && authMode !== "master") {
    ok("relay whoami authenticated");
    return;
  }
  const turn = body.turn as { provider?: unknown } | undefined;
  const provider = knownIceProvider(turn?.provider);
  const turnSuffix = provider !== null ? `, TURN provider: ${provider}` : "";

  if (authMode === "jwt") {
    const namespace =
      typeof body.namespace === "string" && HOST_NAMESPACE_PATTERN.test(body.namespace)
        ? body.namespace
        : null;
    const tokenUse = body.tokenUse === "host" || body.tokenUse === "session" ? body.tokenUse : null;
    const scopes = Array.isArray(body.scopes)
      ? body.scopes
          .filter(
            (scope): scope is string => typeof scope === "string" && /^[A-Za-z]{1,32}$/.test(scope),
          )
          .join(",")
      : null;
    const expiresAt =
      typeof body.expiresAt === "number" && Number.isSafeInteger(body.expiresAt)
        ? new Date(body.expiresAt * 1000).toISOString()
        : null;
    ok(
      `relay whoami authenticated (auth=jwt` +
        (namespace !== null ? `, namespace=${namespace}` : "") +
        (tokenUse !== null ? `, token_use=${tokenUse}` : "") +
        (scopes !== null && scopes.length > 0 ? `, scope=${scopes}` : "") +
        (expiresAt !== null ? `, expires=${expiresAt}` : "") +
        turnSuffix +
        ")",
    );
    if (namespace !== null && config.namespace !== null && namespace !== config.namespace) {
      warn(
        `whoami namespace "${namespace}" does not match TOKIMEKI_NAMESPACE "${config.namespace}"; host connections would fail the relay prefix check`,
      );
    }
    return;
  }
  if (authMode === "namespace") {
    const namespace =
      typeof body.namespace === "string" && HOST_NAMESPACE_PATTERN.test(body.namespace)
        ? body.namespace
        : null;
    ok(
      `relay whoami authenticated (auth=namespace` +
        (namespace !== null ? `, namespace=${namespace}` : "") +
        turnSuffix +
        ")",
    );
    if (namespace !== null && config.namespace !== null && namespace !== config.namespace) {
      warn(
        `whoami namespace "${namespace}" does not match TOKIMEKI_NAMESPACE "${config.namespace}"; host connections would fail the relay prefix check`,
      );
    }
    return;
  }
  ok(`relay whoami authenticated (auth=master${turnSuffix})`);
}

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
  const checks: ReportCheck[] = [];
  let failures = 0;

  const write = (line: string): void => {
    lines.push(redact(line));
    try {
      stdout.write(`${redact(line)}\n`);
    } catch {
      // best effort
    }
  };
  const ok = (label: string): void => {
    checks.push({ name: label, status: "ok" });
    write(`[ok] ${label}`);
  };
  const warn = (label: string): void => {
    checks.push({ name: label, status: "warn" });
    write(`[warn] ${label}`);
  };
  const fail = (label: string): void => {
    failures += 1;
    checks.push({ name: label, status: "fail" });
    write(`[fail] ${label}`);
  };

  write("tokimeki doctor");

  if (config.relayUrl === null) {
    fail("TOKIMEKI_RELAY_URL is missing or invalid");
  } else {
    ok(`relay URL: ${config.relayUrl}`);
  }

  if (config.configFilePath !== null) {
    ok(`config file loaded (${config.configFilePath})`);
  }

  if (config.hasToken) {
    const scope = config.namespace === null ? "no namespace" : `namespace=${config.namespace}`;
    ok(`host authentication environment is present (TOKIMEKI_TOKEN, ${scope})`);
  } else if (config.masterToken !== null) {
    ok(
      "single-owner fallback authentication environment is present (TOKIMEKI_MASTER_TOKEN; a relay with namespace tokens will reject it)",
    );
  } else {
    warn(
      "no host token is set (set TOKIMEKI_NAMESPACE and TOKIMEKI_TOKEN, or TOKIMEKI_MASTER_TOKEN, to host a session)",
    );
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

  if (config.hasPasscode) {
    ok("session passcode is configured (TOKIMEKI_PASSCODE)");
  }

  if (config.authMode === null && !attachComplete) {
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

    // `/healthz` is intentionally minimal; TURN/auth details live behind the
    // authenticated `/auth/whoami`. Older relays do not implement it, so a
    // failure is a warning rather than a failed check (and never a token echo).
    // The probe uses the effective host credential: TOKIMEKI_TOKEN first, then
    // the single-owner fallback credential, always on X-Tokimeki-Token.
    const effectiveToken = config.token ?? config.masterToken;
    if (effectiveToken !== null) {
      const whoamiUrl = relayWhoamiUrl(config.relayUrl);
      try {
        const response = await fetchImpl(whoamiUrl, {
          headers: buildHostAuthHeaders(effectiveToken),
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        if (response.ok) {
          const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
          describeWhoami(body, config, warn, ok);
        } else if (response.status === 401 || response.status === 404) {
          const hint =
            config.token !== null
              ? "the token is invalid, the relay has neither JWT nor namespace-token auth enabled, or the X-Tokimeki-Token header versions do not match"
              : "the relay may have namespace tokens enabled, which disables the fallback token; switch to TOKIMEKI_NAMESPACE + TOKIMEKI_TOKEN";
          warn(`relay whoami returned HTTP ${response.status} (${hint})`);
        } else {
          warn(
            `relay whoami returned HTTP ${response.status} (older relay or invalid credential?)`,
          );
        }
      } catch (error) {
        warn(`relay whoami unreachable at ${whoamiUrl}: ${formatError(error)}`);
      }
    }
  }

  const report = { ok: failures === 0, checks: [...checks] };
  if (failures === 0) {
    write("result: all checks passed");
    deps.onReport?.(report);
    return 0;
  }
  write(`result: ${failures} check(s) failed`);
  deps.onReport?.(report);
  return 1;
}
