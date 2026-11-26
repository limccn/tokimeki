/**
 * Structured relay logging.
 *
 * Log records only contain an allow-listed set of routing/diagnostic fields.
 * Tokens, authentication headers, TURN secrets/credentials, terminal payloads,
 * signal payloads, and raw protocol error details are never logged.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const ALLOWED_FIELDS = new Set([
  "sessionId",
  "clientId",
  "role",
  "namespace",
  "code",
  "closeCode",
  "type",
  "requestId",
  "provider",
  "requestedProvider",
  "clientCount",
  "socketCount",
  "maxClients",
  "bytes",
  "seq",
  "unackedBytes",
  "reason",
  "state",
  "mode",
  "hasToken",
  "durationMs",
  // Quota diagnostics: the breached limit kind and numeric boundary. Never a
  // payload, token, or credential.
  "kind",
  "limit",
  "observed",
  // Host lifecycle and TURN fallback diagnostics (numeric/boolean/short enum).
  "exitCode",
  "signal",
  "fallback",
  // v1.7 rate-limit / auth-failure diagnostics. Never a token, passcode, or
  // raw client IP: `ipHashPrefix` is a truncated SHA-256 hex prefix.
  "path",
  "ipHashPrefix",
  "failedAttempts",
]);

function parseLogLevel(raw: string | undefined): LogLevel {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "debug":
      return "debug";
    case "warn":
      return "warn";
    case "error":
      return "error";
    case "silent":
      return "error";
    default:
      return "info";
  }
}

function sanitize(fields: LogFields | undefined): LogFields {
  const sanitized: LogFields = {};
  if (fields === undefined) {
    return sanitized;
  }
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key)) {
      continue;
    }
    if (
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      if (value !== undefined) {
        sanitized[key] = value;
      }
    }
  }
  return sanitized;
}

function emit(level: LogLevel, event: string, fields: LogFields): void {
  const line = JSON.stringify({ level, event, ts: Date.now(), ...fields });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/** Create a logger scoped to a Worker environment and optional safe base fields. */
export function createLogger(
  env: { readonly TOKIMEKI_LOG_LEVEL?: string },
  base: LogFields = {},
): Logger {
  const threshold = LEVEL_PRIORITY[parseLogLevel(env.TOKIMEKI_LOG_LEVEL)];
  const baseFields = sanitize(base);

  const write = (level: LogLevel, event: string, fields?: LogFields): void => {
    if (LEVEL_PRIORITY[level] < threshold) {
      return;
    }
    emit(level, event, { ...baseFields, ...sanitize(fields) });
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
