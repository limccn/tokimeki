/**
 * JSON config envelope (`TOKIMEKI_CONFIG`).
 *
 * This is a convenience layer over the existing environment variables: JSON
 * fields are mapped to their `TOKIMEKI_*` equivalents, and explicit env vars
 * win. It never reads or writes files and it never moves secrets into argv.
 */

export class ConfigEnvelopeError extends Error {
  override readonly name = "ConfigEnvelopeError";
}

type FieldKind = "string" | "integer" | "boolean" | "string-list" | "size";

interface FieldMapping {
  readonly env: string;
  readonly kind: FieldKind;
}

const FIELDS: Readonly<Record<string, FieldMapping>> = {
  relayUrl: { env: "TOKIMEKI_RELAY_URL", kind: "string" },
  session: { env: "TOKIMEKI_SESSION", kind: "string" },
  sessionToken: { env: "TOKIMEKI_SESSION_TOKEN", kind: "string" },
  token: { env: "TOKIMEKI_TOKEN", kind: "string" },
  masterToken: { env: "TOKIMEKI_MASTER_TOKEN", kind: "string" },
  // Retired: kept only so `resolveConfigEnv` / the loaders can reject it with
  // a rename hint. It is never promoted to a usable credential.
  namespaceToken: { env: "TOKIMEKI_NAMESPACE_TOKEN", kind: "string" },
  namespace: { env: "TOKIMEKI_NAMESPACE", kind: "string" },
  window: { env: "TOKIMEKI_WINDOW_SIZE", kind: "size" },
  windowSize: { env: "TOKIMEKI_WINDOW_SIZE", kind: "size" },
  ptySize: { env: "TOKIMEKI_PTY_SIZE", kind: "size" },
  windowMode: { env: "TOKIMEKI_WINDOW", kind: "string" },
  windowTui: { env: "TOKIMEKI_WINDOW_TUI", kind: "string-list" },
  windowTuiCommands: { env: "TOKIMEKI_WINDOW_TUI", kind: "string-list" },
  logViewRows: { env: "TOKIMEKI_LOG_VIEW_ROWS", kind: "integer" },
  logPanelRows: { env: "TOKIMEKI_LOG_PANEL_ROWS", kind: "integer" },
  inviteKey: { env: "TOKIMEKI_INVITE_KEY", kind: "string" },
  p2p: { env: "TOKIMEKI_P2P", kind: "string" },
  iceTransportPolicy: { env: "TOKIMEKI_ICE_TRANSPORT_POLICY", kind: "string" },
  logLevel: { env: "TOKIMEKI_LOG_LEVEL", kind: "string" },
  term: { env: "TOKIMEKI_TERM", kind: "string" },
  colorterm: { env: "TOKIMEKI_COLORTERM", kind: "string" },
  resizePolicy: { env: "TOKIMEKI_RESIZE_POLICY", kind: "string" },
  heartbeatSeconds: { env: "TOKIMEKI_HEARTBEAT_SECONDS", kind: "integer" },
  scrollbackLines: { env: "TOKIMEKI_SCROLLBACK_LINES", kind: "integer" },
  snapshotMaxBytes: { env: "TOKIMEKI_SNAPSHOT_MAX_BYTES", kind: "integer" },
  listenerSnapshotMs: { env: "TOKIMEKI_LISTENER_SNAPSHOT_MS", kind: "integer" },
  tunnel: { env: "TOKIMEKI_TUNNEL", kind: "string" },
  tunnelFec: { env: "TOKIMEKI_TUNNEL_FEC", kind: "string" },
  tunnelSecret: { env: "TOKIMEKI_TUNNEL_SECRET", kind: "string" },
  passcode: { env: "TOKIMEKI_PASSCODE", kind: "string" },
  piTuiMode: { env: "TOKIMEKI_PI_TUI_MODE", kind: "string" },
  claudeBg: { env: "TOKIMEKI_CLAUDE_BG", kind: "boolean" },
};

const MAX_CONFIG_CHARS = 65_536;
const SIZE_PATTERN = /^(\d+)\s*[xX]\s*(\d+)$/;

function fieldError(name: string, expected: string): ConfigEnvelopeError {
  return new ConfigEnvelopeError(`TOKIMEKI_CONFIG.${name} must be ${expected}`);
}

function encodeSize(name: string, value: unknown): string {
  if (typeof value === "string") {
    if (!SIZE_PATTERN.test(value.trim())) throw fieldError(name, "<cols>x<rows>");
    return value.trim();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw fieldError(name, "{ cols, rows }");
  }
  const record = value as Record<string, unknown>;
  const cols = record.cols;
  const rows = record.rows;
  if (
    !Number.isSafeInteger(cols) ||
    !Number.isSafeInteger(rows) ||
    (cols as number) < 1 ||
    (rows as number) < 1
  ) {
    throw fieldError(name, "{ cols, rows } with positive integers");
  }
  return `${String(cols)}x${String(rows)}`;
}

function encodeStringList(name: string, value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw fieldError(name, "a string or string[]");
  }
  return value.join(",");
}

function encodeInteger(name: string, value: unknown): string {
  if (!Number.isSafeInteger(value)) throw fieldError(name, "an integer");
  return String(value);
}

function encodeValue(name: string, kind: FieldKind, value: unknown): string {
  switch (kind) {
    case "string":
      if (typeof value !== "string") throw fieldError(name, "a string");
      return value;
    case "integer":
      return encodeInteger(name, value);
    case "boolean":
      if (typeof value !== "boolean") throw fieldError(name, "a boolean");
      return value ? "1" : "0";
    case "string-list":
      return encodeStringList(name, value);
    case "size":
      return encodeSize(name, value);
    default:
      throw fieldError(name, "a supported value");
  }
}

/**
 * Parse `TOKIMEKI_CONFIG` into the env-var subset it contributes.
 *
 * Throws `ConfigEnvelopeError` with field names (never values). The caller
 * merges the result underneath the explicit process environment.
 */
export function parseConfigEnvelope(raw: string): Record<string, string> {
  if (raw.length > MAX_CONFIG_CHARS) {
    throw new ConfigEnvelopeError("TOKIMEKI_CONFIG is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigEnvelopeError("TOKIMEKI_CONFIG must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigEnvelopeError("TOKIMEKI_CONFIG must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const version = record.version ?? record.v;
  // v2 adds optional namespace/expiresAt/passcodeRequired fields used by the
  // TokiAPI viewer config; unknown fields are ignored, so the CLI consumes the
  // same keys as v1 and only accepts the newer version marker.
  if (version !== undefined && version !== 1 && version !== 2) {
    throw new ConfigEnvelopeError("TOKIMEKI_CONFIG.version must be 1 or 2");
  }
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(record)) {
    const mapping = FIELDS[name];
    if (mapping === undefined) continue; // forward-compatible: ignore unknown fields
    env[mapping.env] = encodeValue(name, mapping.kind, value);
  }
  return env;
}
