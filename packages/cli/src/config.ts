/**
 * Environment-driven configuration for the tokimeki CLI.
 *
 * Every runtime knob is an environment variable; only `--help`/`--version`
 * style flags are accepted on the command line. Secrets are never part of a
 * URL or a log line: they travel in WebSocket headers only.
 */

import { randomBytes } from "node:crypto";
import { hostname as defaultHostname } from "node:os";
import {
  isTerminalSizeWithinLimits,
  isValidSessionId,
  MAX_TERMINAL_DIMENSION,
  MIN_TUNNEL_SECRET_BYTES,
  RESIZE_POLICIES,
  type ResizePolicy,
  type TunnelKeyMode,
} from "@limccn/tokimeki-protocol";
import { ConfigEnvelopeError, parseConfigEnvelope } from "./config-envelope.js";
import { INVITE_KEYS, type InviteKey } from "./invite.js";
import { isLogLevel, LOG_LEVELS, type LogLevel } from "./logger.js";
import { parseTuiCommandList, WINDOW_MODES, type WindowMode } from "./window-policy.js";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export type P2PMode = "auto" | "off";
export type IceTransportPolicy = "all" | "relay";
export type PiTuiMode = "fullscreen" | "regular";
/** TUN profile switch (`TOKIMEKI_TUNNEL`). F1 is opt-in. */
export type TunnelMode = "off" | "auto";
/** Local parity sender policy (`TOKIMEKI_TUNNEL_FEC`). */
export type TunnelFecMode = "off" | "xor";

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export interface CommonConfig {
  /** Normalized relay base URL (`ws://` or `wss://`, no trailing slash). */
  readonly relayUrl: string;
  /** Fully normalized WebSocket URL including `/ws/<session>`. */
  readonly websocketUrl: string;
  readonly session: string;
  readonly heartbeatSeconds: number;
  readonly p2p: P2PMode;
  readonly iceTransportPolicy: IceTransportPolicy;
  /** Opt-in v1.1 TUN profile; default off. P2P-only. */
  readonly tunnel: TunnelMode;
  /** Local parity sender policy; `off` never sends FEC records. */
  readonly tunnelFec: TunnelFecMode;
  readonly tunnelKeyMode: TunnelKeyMode;
  /** Shared secret for relay-blind mode; null derives from the session token. */
  readonly tunnelSecret: string | null;
  readonly logLevel: LogLevel;
  /** Global TUI window switch (`TOKIMEKI_WINDOW`). */
  readonly windowMode: WindowMode;
  /** One-line warnings (for example, recognized-but-unimplemented v1.1 vars). */
  readonly warnings: readonly string[];
  /** Known secret values; the logger redacts every occurrence of these. */
  readonly secrets: readonly string[];
}

export interface HostConfig extends CommonConfig {
  readonly role: "host";
  readonly masterToken: string;
  readonly sessionToken: string;
  readonly sessionTokenGenerated: boolean;
  readonly term: string;
  readonly colorterm: string;
  readonly resizePolicy: ResizePolicy;
  readonly ptySize: TerminalSize | null;
  /** Fixed logical window when `TOKIMEKI_PTY_SIZE` is not set. */
  readonly windowSize: TerminalSize;
  /** Commands that opt into the fixed TUI window when `windowMode=tui`. */
  readonly windowTuiCommands: ReadonlySet<string>;
  /** Debug log panel rows; 0 disables the panel. */
  readonly logPanelRows: number;
  /** Local key that reopens the viewer-config overlay. */
  readonly inviteKey: InviteKey;
  readonly scrollbackLines: number;
  readonly snapshotMaxBytes: number;
  readonly listenerSnapshotMs: number;
  readonly piTuiMode: PiTuiMode;
  readonly claudeBg: boolean;
}

export interface AttachConfig extends CommonConfig {
  /** `listener` is the v1.1 read-only snapshot-only mode (`attach --listen`). */
  readonly role: "viewer" | "listener";
  readonly sessionToken: string;
  /** Debug log panel rows; 0 disables the panel. */
  readonly logPanelRows: number;
}

export interface DoctorConfig {
  readonly relayUrl: string | null;
  readonly session: string | null;
  readonly hasMasterToken: boolean;
  readonly hasSessionToken: boolean;
  readonly warnings: readonly string[];
  readonly secrets: readonly string[];
}

export interface HostConfigInputs {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly hostname?: string;
}

const V11_ENV_VARS = [
  "TOKIMEKI_TUNNEL_WINDOW",
  "TOKIMEKI_TUNNEL_MTU",
  "TOKIMEKI_VIEW_MODE",
  "TOKIMEKI_ROUTE_POLICY",
  "TOKIMEKI_LAN_DISCOVERY",
  "TOKIMEKI_LAN_FANOUT",
] as const;

export const DEFAULT_HEARTBEAT_SECONDS = 25;
export const DEFAULT_SCROLLBACK_LINES = 1000;
export const MIN_SCROLLBACK_LINES = 500;
export const MAX_SCROLLBACK_LINES = 2000;
export const DEFAULT_SNAPSHOT_MAX_BYTES = 262_144;
export const DEFAULT_LISTENER_SNAPSHOT_MS = 1000;
export const MIN_LISTENER_SNAPSHOT_MS = 250;
export const MAX_LISTENER_SNAPSHOT_MS = 60_000;
export const DEFAULT_TERM = "xterm-256color";
export const DEFAULT_COLORTERM = "truecolor";
export const DEFAULT_WINDOW_SIZE: TerminalSize = { cols: 120, rows: 40 };
export const DEFAULT_LOG_PANEL_ROWS = 8;
export const MAX_LOG_PANEL_ROWS = 200;

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new ConfigError(`${name} is required`);
  }
  return value;
}

/**
 * Merge a JSON config envelope underneath the explicit process environment.
 *
 * Empty environment strings are treated as unset so a `.env` placeholder such
 * as `TOKIMEKI_SESSION_TOKEN=` does not erase a config-provided value.
 */
function applyConfigEnvelope(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const raw = env.TOKIMEKI_CONFIG;
  if (raw === undefined || raw.trim() === "") return env;
  let mapped: Record<string, string>;
  try {
    mapped = parseConfigEnvelope(raw);
  } catch (error) {
    const message =
      error instanceof ConfigEnvelopeError ? error.message : "TOKIMEKI_CONFIG is invalid";
    throw new ConfigError(message);
  }
  const merged: NodeJS.ProcessEnv = { ...mapped };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (value === "" && key !== "TOKIMEKI_CONFIG") continue;
    merged[key] = value;
  }
  return merged;
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.length === 0 ? undefined : value;
}

function parseInteger(
  name: string,
  raw: string,
  options: { min?: number; max?: number } = {},
): number {
  if (!/^[+-]?\d+$/.test(raw.trim())) {
    throw new ConfigError(`${name} must be an integer (received ${JSON.stringify(raw)})`);
  }
  const value = Number.parseInt(raw.trim(), 10);
  if (options.min !== undefined && value < options.min) {
    throw new ConfigError(`${name} must be at least ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new ConfigError(`${name} must be at most ${options.max}`);
  }
  return value;
}

function parseEnum<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (raw === undefined) return fallback;
  if ((allowed as readonly string[]).includes(raw)) {
    return raw as T;
  }
  throw new ConfigError(
    `${name} must be one of ${allowed.join(", ")} (received ${JSON.stringify(raw)})`,
  );
}

export function parseBooleanish(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  throw new ConfigError(`${name} must be a boolean-like value (1/0/true/false)`);
}

/**
 * Normalize a relay URL to a WebSocket base URL.
 *
 * `https://` becomes `wss://`, `http://` becomes `ws://`, trailing slashes are
 * stripped, and query strings/hashes are rejected because credentials must
 * never be placed in a URL.
 */
export function normalizeRelayBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError("TOKIMEKI_RELAY_URL is not a valid URL");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ConfigError(
      "TOKIMEKI_RELAY_URL must not contain credentials; use environment tokens instead",
    );
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new ConfigError(
      "TOKIMEKI_RELAY_URL must not contain a query string or fragment; tokens belong in headers",
    );
  }
  let protocol: string;
  switch (parsed.protocol) {
    case "wss:":
    case "https:":
      protocol = "wss:";
      break;
    case "ws:":
    case "http:":
      protocol = "ws:";
      break;
    default:
      throw new ConfigError(
        `TOKIMEKI_RELAY_URL must use http(s):// or ws(s):// (received ${parsed.protocol})`,
      );
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${protocol}//${parsed.host}${pathname}`;
}

/** Convert a relay base URL into the `/healthz` HTTP(S) endpoint. */
export function relayHealthUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  const protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${protocol}//${parsed.host}${pathname}/healthz`;
}

/** Append `/ws/<session>` and the role hint to a normalized relay base URL. */
export function buildRelayWebSocketUrl(baseUrl: string, session: string): string {
  if (!isValidSessionId(session)) {
    throw new ConfigError("TOKIMEKI_SESSION must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
  }
  // The URL carries only the public session name. The connection role and
  // every credential travel in headers/hello, never in the query string.
  return `${baseUrl}/ws/${session}`;
}

/** Sanitize an arbitrary string into a valid session ID. */
export function sanitizeSessionId(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : "session";
}

/** Recognize v1.1-only variables and describe them without printing values. */
export function collectV11Warnings(env: NodeJS.ProcessEnv): string[] {
  const present = V11_ENV_VARS.filter((name) => optionalEnv(env, name) !== undefined);
  if (present.length === 0) return [];
  return [`v1.1 options are not implemented in this release; ignoring ${present.join(", ")}`];
}

function parseHeartbeat(env: NodeJS.ProcessEnv): number {
  const raw = optionalEnv(env, "TOKIMEKI_HEARTBEAT_SECONDS");
  if (raw === undefined) return DEFAULT_HEARTBEAT_SECONDS;
  return parseInteger("TOKIMEKI_HEARTBEAT_SECONDS", raw, { min: 0, max: 3600 });
}

function parseScrollback(env: NodeJS.ProcessEnv): number {
  const raw = optionalEnv(env, "TOKIMEKI_SCROLLBACK_LINES");
  if (raw === undefined) return DEFAULT_SCROLLBACK_LINES;
  const value = parseInteger("TOKIMEKI_SCROLLBACK_LINES", raw, { min: 1 });
  return Math.min(MAX_SCROLLBACK_LINES, Math.max(MIN_SCROLLBACK_LINES, value));
}

function parseSnapshotMax(env: NodeJS.ProcessEnv): number {
  const raw = optionalEnv(env, "TOKIMEKI_SNAPSHOT_MAX_BYTES");
  if (raw === undefined) return DEFAULT_SNAPSHOT_MAX_BYTES;
  return parseInteger("TOKIMEKI_SNAPSHOT_MAX_BYTES", raw, { min: 1024, max: 900_000 });
}

/**
 * Listener snapshot interval (`TOKIMEKI_LISTENER_SNAPSHOT_MS`).
 *
 * Out-of-range values are clamped and non-integer values fall back to the
 * default with a warning instead of aborting the host: this timer only affects
 * the optional read-only fan-out and must not block the shared PTY session.
 */
function parseListenerSnapshotMs(env: NodeJS.ProcessEnv, warnings: string[]): number {
  const raw = optionalEnv(env, "TOKIMEKI_LISTENER_SNAPSHOT_MS");
  if (raw === undefined) return DEFAULT_LISTENER_SNAPSHOT_MS;
  if (!/^\d+$/.test(raw.trim())) {
    warnings.push(
      `TOKIMEKI_LISTENER_SNAPSHOT_MS must be an integer; using ${DEFAULT_LISTENER_SNAPSHOT_MS}`,
    );
    return DEFAULT_LISTENER_SNAPSHOT_MS;
  }
  const value = Number.parseInt(raw.trim(), 10);
  if (value < MIN_LISTENER_SNAPSHOT_MS) {
    warnings.push(`TOKIMEKI_LISTENER_SNAPSHOT_MS is below ${MIN_LISTENER_SNAPSHOT_MS}; clamping`);
    return MIN_LISTENER_SNAPSHOT_MS;
  }
  if (value > MAX_LISTENER_SNAPSHOT_MS) {
    warnings.push(`TOKIMEKI_LISTENER_SNAPSHOT_MS is above ${MAX_LISTENER_SNAPSHOT_MS}; clamping`);
    return MAX_LISTENER_SNAPSHOT_MS;
  }
  return value;
}

function parseTerminalSize(name: string, raw: string): TerminalSize {
  const match = /^(\d+)\s*[xX]\s*(\d+)$/.exec(raw.trim());
  if (match === null) {
    throw new ConfigError(`${name} must use the <cols>x<rows> form`);
  }
  const cols = Number.parseInt(match[1] ?? "", 10);
  const rows = Number.parseInt(match[2] ?? "", 10);
  if (cols < 1 || rows < 1 || cols > MAX_TERMINAL_DIMENSION || rows > MAX_TERMINAL_DIMENSION) {
    throw new ConfigError(
      `${name} must be between 1x1 and ${MAX_TERMINAL_DIMENSION}x${MAX_TERMINAL_DIMENSION}`,
    );
  }
  if (!isTerminalSizeWithinLimits(cols, rows)) {
    throw new ConfigError(`${name} exceeds the terminal cell limit`);
  }
  return { cols, rows };
}

function parsePtySize(env: NodeJS.ProcessEnv): TerminalSize | null {
  const raw = optionalEnv(env, "TOKIMEKI_PTY_SIZE");
  if (raw === undefined) return null;
  return parseTerminalSize("TOKIMEKI_PTY_SIZE", raw);
}

function parseWindowSize(env: NodeJS.ProcessEnv): TerminalSize {
  const raw = optionalEnv(env, "TOKIMEKI_WINDOW_SIZE");
  if (raw === undefined) {
    return { cols: DEFAULT_WINDOW_SIZE.cols, rows: DEFAULT_WINDOW_SIZE.rows };
  }
  return parseTerminalSize("TOKIMEKI_WINDOW_SIZE", raw);
}

function parseWindowMode(env: NodeJS.ProcessEnv): WindowMode {
  return parseEnum("TOKIMEKI_WINDOW", optionalEnv(env, "TOKIMEKI_WINDOW"), WINDOW_MODES, "tui");
}

function parseLogPanelRows(env: NodeJS.ProcessEnv): number {
  const raw = optionalEnv(env, "TOKIMEKI_LOG_PANEL_ROWS");
  if (raw === undefined) return DEFAULT_LOG_PANEL_ROWS;
  return parseInteger("TOKIMEKI_LOG_PANEL_ROWS", raw, { min: 0, max: MAX_LOG_PANEL_ROWS });
}

function parseLogLevel(env: NodeJS.ProcessEnv, warnings: string[]): LogLevel {
  const raw = optionalEnv(env, "TOKIMEKI_LOG_LEVEL");
  if (raw === undefined) return "info";
  if (isLogLevel(raw)) return raw;
  warnings.push(`TOKIMEKI_LOG_LEVEL is not one of ${LOG_LEVELS.join(", ")}; using info`);
  return "info";
}

function parseP2P(env: NodeJS.ProcessEnv): P2PMode {
  return parseEnum(
    "TOKIMEKI_P2P",
    optionalEnv(env, "TOKIMEKI_P2P"),
    ["auto", "off"] as const,
    "auto",
  );
}

function parseIcePolicy(env: NodeJS.ProcessEnv): IceTransportPolicy {
  return parseEnum(
    "TOKIMEKI_ICE_TRANSPORT_POLICY",
    optionalEnv(env, "TOKIMEKI_ICE_TRANSPORT_POLICY"),
    ["all", "relay"] as const,
    "all",
  );
}

interface CommonConfigParts {
  readonly relayUrl: string;
  readonly websocketUrl: string;
  readonly session: string;
  readonly heartbeatSeconds: number;
  readonly p2p: P2PMode;
  readonly iceTransportPolicy: IceTransportPolicy;
  readonly tunnel: TunnelMode;
  readonly tunnelFec: TunnelFecMode;
  readonly tunnelKeyMode: TunnelKeyMode;
  readonly tunnelSecret: string | null;
  readonly logLevel: LogLevel;
  readonly windowMode: WindowMode;
  readonly warnings: string[];
  readonly secrets: string[];
}

function parseTunnelMode(env: NodeJS.ProcessEnv): TunnelMode {
  return parseEnum(
    "TOKIMEKI_TUNNEL",
    optionalEnv(env, "TOKIMEKI_TUNNEL"),
    ["off", "auto"] as const,
    "off",
  );
}

function parseTunnelFec(env: NodeJS.ProcessEnv): TunnelFecMode {
  const raw = optionalEnv(env, "TOKIMEKI_TUNNEL_FEC");
  if (raw === undefined) return "off";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "off" || normalized === "none" || normalized === "0") return "off";
  if (normalized === "xor") return "xor";
  throw new ConfigError(
    `TOKIMEKI_TUNNEL_FEC must be one of off, xor (received ${JSON.stringify(raw)})`,
  );
}

function parseTunnelSecret(env: NodeJS.ProcessEnv, tunnel: TunnelMode): string | null {
  const raw = optionalEnv(env, "TOKIMEKI_TUNNEL_SECRET");
  if (raw === undefined) return null;
  if (tunnel === "auto" && Buffer.byteLength(raw, "utf8") < MIN_TUNNEL_SECRET_BYTES) {
    throw new ConfigError(
      `TOKIMEKI_TUNNEL_SECRET must be at least ${MIN_TUNNEL_SECRET_BYTES} bytes when TOKIMEKI_TUNNEL=auto`,
    );
  }
  return raw;
}

function loadCommon(env: NodeJS.ProcessEnv, session: string): CommonConfigParts {
  const relayUrl = normalizeRelayBaseUrl(requireEnv(env, "TOKIMEKI_RELAY_URL"));
  if (!isValidSessionId(session)) {
    throw new ConfigError("TOKIMEKI_SESSION must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
  }
  const warnings: string[] = [];
  warnings.push(...collectV11Warnings(env));
  const logLevel = parseLogLevel(env, warnings);
  const p2p = parseP2P(env);
  const tunnel = parseTunnelMode(env);
  const tunnelFec = parseTunnelFec(env);
  const tunnelSecret = parseTunnelSecret(env, tunnel);
  if (tunnel === "auto" && p2p === "off") {
    warnings.push("TOKIMEKI_TUNNEL=auto requires P2P; the tunnel will not be used");
  }
  const secrets = [
    optionalEnv(env, "TOKIMEKI_MASTER_TOKEN"),
    optionalEnv(env, "TOKIMEKI_SESSION_TOKEN"),
    optionalEnv(env, "TOKIMEKI_TUNNEL_SECRET"),
  ].filter((value): value is string => value !== undefined);
  return {
    relayUrl,
    websocketUrl: buildRelayWebSocketUrl(relayUrl, session),
    session,
    heartbeatSeconds: parseHeartbeat(env),
    p2p,
    iceTransportPolicy: parseIcePolicy(env),
    tunnel,
    tunnelFec,
    tunnelKeyMode: tunnelSecret === null ? "session-token" : "shared-secret",
    tunnelSecret,
    logLevel,
    windowMode: parseWindowMode(env),
    warnings,
    secrets,
  };
}

export function loadHostConfig(inputs: HostConfigInputs = {}): HostConfig {
  const env = applyConfigEnvelope(inputs.env ?? process.env);
  const cwd = inputs.cwd ?? process.cwd();
  const hostname = inputs.hostname ?? defaultHostname();
  const masterToken = requireEnv(env, "TOKIMEKI_MASTER_TOKEN");
  const explicitSession = optionalEnv(env, "TOKIMEKI_SESSION");
  const session = explicitSession ?? sanitizeSessionId(`${hostname}-${cwd}`);
  const envSessionToken = optionalEnv(env, "TOKIMEKI_SESSION_TOKEN");
  const sessionToken = envSessionToken ?? randomBytes(32).toString("base64url");
  if (masterToken === sessionToken) {
    // Never let the value shared with viewers double as the host master token.
    throw new ConfigError("TOKIMEKI_MASTER_TOKEN and TOKIMEKI_SESSION_TOKEN must be different");
  }
  const common = loadCommon(env, session);
  return {
    ...common,
    role: "host",
    masterToken,
    sessionToken,
    sessionTokenGenerated: envSessionToken === undefined,
    term: optionalEnv(env, "TOKIMEKI_TERM") ?? DEFAULT_TERM,
    colorterm: optionalEnv(env, "TOKIMEKI_COLORTERM") ?? DEFAULT_COLORTERM,
    resizePolicy: parseEnum(
      "TOKIMEKI_RESIZE_POLICY",
      optionalEnv(env, "TOKIMEKI_RESIZE_POLICY"),
      RESIZE_POLICIES,
      "latest",
    ),
    ptySize: parsePtySize(env),
    windowSize: parseWindowSize(env),
    windowTuiCommands: parseTuiCommandList(env.TOKIMEKI_WINDOW_TUI),
    logPanelRows: parseLogPanelRows(env),
    inviteKey: parseEnum(
      "TOKIMEKI_INVITE_KEY",
      optionalEnv(env, "TOKIMEKI_INVITE_KEY"),
      INVITE_KEYS,
      "f12",
    ),
    scrollbackLines: parseScrollback(env),
    snapshotMaxBytes: parseSnapshotMax(env),
    listenerSnapshotMs: parseListenerSnapshotMs(env, common.warnings),
    piTuiMode: parseEnum(
      "TOKIMEKI_PI_TUI_MODE",
      optionalEnv(env, "TOKIMEKI_PI_TUI_MODE"),
      ["fullscreen", "regular"] as const,
      "fullscreen",
    ),
    claudeBg: parseBooleanish("TOKIMEKI_CLAUDE_BG", optionalEnv(env, "TOKIMEKI_CLAUDE_BG"), false),
    secrets: [...common.secrets, masterToken, sessionToken],
  };
}

export interface AttachConfigOptions {
  /** Connect as a read-only snapshot-only listener (`attach --listen`). */
  readonly listener?: boolean;
}

export function loadAttachConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: AttachConfigOptions = {},
): AttachConfig {
  env = applyConfigEnvelope(env);
  const session = requireEnv(env, "TOKIMEKI_SESSION");
  const sessionToken = requireEnv(env, "TOKIMEKI_SESSION_TOKEN");
  const common = loadCommon(env, session);
  const role = options.listener === true ? "listener" : "viewer";
  if (role === "listener" && common.tunnel === "auto") {
    common.warnings.push("TOKIMEKI_TUNNEL=auto is ignored for read-only listeners");
  }
  return {
    ...common,
    role,
    sessionToken,
    logPanelRows: parseLogPanelRows(env),
    secrets: [...common.secrets, sessionToken],
  };
}

/**
 * Lenient configuration for `tokimeki doctor`.
 *
 * Doctor must be able to report problems instead of throwing on the first one,
 * so this only normalizes what is present and lets the command assemble the
 * pass/fail report.
 */
export function loadDoctorConfig(env: NodeJS.ProcessEnv = process.env): DoctorConfig {
  const warnings: string[] = [...collectV11Warnings(env)];
  try {
    env = applyConfigEnvelope(env);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : "TOKIMEKI_CONFIG is invalid");
  }
  const relayRaw = optionalEnv(env, "TOKIMEKI_RELAY_URL");
  let relayUrl: string | null = null;
  if (relayRaw !== undefined) {
    try {
      relayUrl = normalizeRelayBaseUrl(relayRaw);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  const sessionRaw = optionalEnv(env, "TOKIMEKI_SESSION");
  let session: string | null = null;
  if (sessionRaw !== undefined) {
    if (isValidSessionId(sessionRaw)) {
      session = sessionRaw;
    } else {
      warnings.push("TOKIMEKI_SESSION is not a valid session ID");
    }
  }
  parseLogLevel(env, warnings);
  const masterToken = optionalEnv(env, "TOKIMEKI_MASTER_TOKEN");
  const sessionToken = optionalEnv(env, "TOKIMEKI_SESSION_TOKEN");
  if (masterToken !== undefined && sessionToken !== undefined && masterToken === sessionToken) {
    warnings.push(
      "TOKIMEKI_MASTER_TOKEN and TOKIMEKI_SESSION_TOKEN are identical; use different values",
    );
  }
  const secrets = [masterToken, sessionToken, optionalEnv(env, "TOKIMEKI_TUNNEL_SECRET")].filter(
    (value): value is string => value !== undefined,
  );
  return {
    relayUrl,
    session,
    hasMasterToken: masterToken !== undefined,
    hasSessionToken: sessionToken !== undefined,
    warnings,
    secrets,
  };
}
