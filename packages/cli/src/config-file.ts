/**
 * Read-only `~/.tokimeki/config.json` support.
 *
 * The CLI never creates, writes back, or chmods this file: it is an optional,
 * user-managed convenience layer. Precedence (lowest to highest):
 *
 *   config.json < TOKIMEKI_CONFIG envelope < explicit process env
 *
 * Host credentials (`TOKIMEKI_TOKEN`, `TOKIMEKI_MASTER_TOKEN`) are selected
 * as a group from the highest layer that defines any of them, so a stale
 * credential in the file cannot shadow an explicit environment credential.
 * Error messages name keys and paths, never values.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ConfigError } from "./config.js";
import { ConfigEnvelopeError, parseConfigEnvelope } from "./config-envelope.js";

export const CONFIG_FILE_MAX_BYTES = 64 * 1024;

export const CONFIG_FILE_SECRET_KEYS = [
  "TOKIMEKI_TOKEN",
  "TOKIMEKI_MASTER_TOKEN",
  // Retired credential key: still treated as secret so a stale file gets the
  // 0600 check before `resolveConfigEnv` rejects it.
  "TOKIMEKI_NAMESPACE_TOKEN",
  "TOKIMEKI_NAMESPACE_TOKENS",
  "TOKIMEKI_SESSION_TOKEN",
  "TOKIMEKI_TUNNEL_SECRET",
  "TOKIMEKI_PASSCODE",
  "TOKIMEKI_COTURN_SECRET",
  "TOKIMEKI_TURN_API_TOKEN",
  "TOKIMEKI_TURN_CREDENTIAL",
  "TOKIMEKI_CONFIG",
] as const;

export interface ConfigFileInfo {
  readonly path: string;
  readonly exists: boolean;
  readonly warnings: readonly string[];
}

export interface ConfigFileResult {
  readonly env: Record<string, string>;
  readonly info: ConfigFileInfo;
}

export function configFileExistsWithSecrets(env: Record<string, string>): boolean {
  return CONFIG_FILE_SECRET_KEYS.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.length > 0;
  });
}

/**
 * POSIX-only permission check for a secret-bearing config file.
 *
 * `0600` is required: group/other permission bits on a file holding tokens
 * would leak credentials to local users. Windows has no POSIX mode bits, so
 * callers report a best-effort warning instead.
 */
export function checkSecretFilePermissions(
  mode: number,
  platform: NodeJS.Platform,
): "ok" | "insecure" | "not-enforced" {
  if (platform === "win32") {
    return "not-enforced";
  }
  return (mode & 0o077) === 0 ? "ok" : "insecure";
}

/**
 * Read `~/.tokimeki/config.json` without ever writing anything.
 *
 * ENOENT yields an empty result; every other problem is a `ConfigError`
 * naming the path (never the values). Keys must be `TOKIMEKI_*` and values
 * scalar; unknown keys are ignored.
 */
export function readConfigFile(
  options: { homeDir?: string; platform?: NodeJS.Platform } = {},
): ConfigFileResult {
  const path = join(options.homeDir ?? homedir(), ".tokimeki", "config.json");
  const warnings: string[] = [];
  let raw: string;
  let stats: import("node:fs").Stats;
  try {
    stats = statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { env: {}, info: { path, exists: false, warnings: [] } };
    }
    throw new ConfigError(`unable to read ${path}: ${code ?? "stat failed"}`);
  }
  if (!stats.isFile()) {
    throw new ConfigError(`${path} is not a regular file`);
  }
  if (stats.size > CONFIG_FILE_MAX_BYTES) {
    throw new ConfigError(`${path} is larger than ${CONFIG_FILE_MAX_BYTES} bytes`);
  }
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ConfigError(`unable to read ${path}: ${code ?? "read failed"}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${path} must contain valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${path} must contain a JSON object`);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key.startsWith("TOKIMEKI_")) {
      continue; // unknown keys are ignored
    }
    if (typeof value === "boolean") {
      env[key] = value ? "1" : "0";
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new ConfigError(`${path}: ${key} must be a string, number, or boolean`);
      }
      env[key] = String(value);
      continue;
    }
    if (typeof value === "string") {
      env[key] = value;
      continue;
    }
    throw new ConfigError(`${path}: ${key} must be a string, number, or boolean`);
  }

  if (configFileExistsWithSecrets(env)) {
    const verdict = checkSecretFilePermissions(stats.mode, options.platform ?? process.platform);
    if (verdict === "insecure") {
      throw new ConfigError(
        `${path} must be 0600 when it contains credentials (run: chmod 600 ${path})`,
      );
    }
    if (verdict === "not-enforced") {
      warnings.push(
        "config file permissions are not enforced on Windows; keep ~/.tokimeki/config.json private",
      );
    }
  }

  return { env, info: { path, exists: true, warnings } };
}

/** Host credential keys, in within-layer priority order. */
const HOST_CREDENTIAL_KEYS = ["TOKIMEKI_TOKEN", "TOKIMEKI_MASTER_TOKEN"] as const;

function findCredential(layer: Record<string, string>): string | null {
  for (const key of HOST_CREDENTIAL_KEYS) {
    const value = layer[key];
    if (typeof value === "string" && value.length > 0) {
      return key;
    }
  }
  return null;
}

/**
 * Merge the config file and the `TOKIMEKI_CONFIG` envelope under the explicit
 * process environment.
 *
 * - Non-credential keys keep key-level precedence (file < envelope < env).
 * - Host credentials are selected as a group from the highest layer that sets
 *   any of them; lower-layer credential keys are dropped with a warning.
 * - `TOKIMEKI_CONFIG` is expanded exactly once and removed from the result, so
 *   the loaders' envelope stage cannot re-inject a dropped credential.
 * - A non-empty retired `TOKIMEKI_NAMESPACE_TOKEN` anywhere is a `ConfigError`
 *   telling the user to rename it to `TOKIMEKI_TOKEN`.
 */
export function resolveConfigEnv(
  processEnv: NodeJS.ProcessEnv,
  options: {
    homeDir?: string;
    platform?: NodeJS.Platform;
    enabled?: boolean;
  } = {},
): { env: NodeJS.ProcessEnv; file: ConfigFileInfo; warnings: readonly string[] } {
  const warnings: string[] = [];
  if (options.enabled === false) {
    return { env: processEnv, file: { path: "", exists: false, warnings }, warnings };
  }

  const file = readConfigFile({ homeDir: options.homeDir, platform: options.platform });
  warnings.push(...file.info.warnings);

  const fileLayer: Record<string, string> = { ...file.env };
  const envelopeRaw = pickFirstNonEmpty(processEnv.TOKIMEKI_CONFIG, fileLayer.TOKIMEKI_CONFIG);
  let envelopeLayer: Record<string, string> = {};
  if (envelopeRaw !== null) {
    try {
      envelopeLayer = parseConfigEnvelope(envelopeRaw);
    } catch (error) {
      const message =
        error instanceof ConfigEnvelopeError ? error.message : "TOKIMEKI_CONFIG is invalid";
      throw new ConfigError(message);
    }
  }

  // Retired key check across all three layers.
  const retiredLayers: Array<[string, Record<string, string | undefined>]> = [
    ["config file", fileLayer],
    ["TOKIMEKI_CONFIG", envelopeLayer],
    ["environment", processEnv],
  ];
  for (const [label, layer] of retiredLayers) {
    const value = layer.TOKIMEKI_NAMESPACE_TOKEN;
    if (typeof value === "string" && value.length > 0) {
      throw new ConfigError(
        `TOKIMEKI_NAMESPACE_TOKEN (${label}) is retired; rename it to TOKIMEKI_TOKEN`,
      );
    }
  }

  // Credential group selection: highest layer that sets any host credential.
  const envLayer: Record<string, string> = {};
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined && value !== "") {
      envLayer[key] = value;
    }
  }
  const layers: Array<Record<string, string>> = [envLayer, envelopeLayer, fileLayer];
  let winningIndex = -1;
  for (let index = 0; index < layers.length; index += 1) {
    if (findCredential(layers[index] ?? {}) !== null) {
      winningIndex = index;
      break;
    }
  }
  const labels = ["environment", "TOKIMEKI_CONFIG", "the config file"];
  if (winningIndex < 0) {
    winningIndex = layers.length; // no credential anywhere: merge everything
  }

  // Merge lowest -> highest, but skip host credential keys from layers below
  // the winning layer so a stale credential cannot be resurrected by key-level
  // priority.
  const merged: NodeJS.ProcessEnv = {};
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index] ?? {};
    const isLowerLayer = index > winningIndex;
    for (const [key, value] of Object.entries(layer)) {
      if (isLowerLayer && (HOST_CREDENTIAL_KEYS as readonly string[]).includes(key)) {
        continue;
      }
      merged[key] = value;
    }
  }
  if (winningIndex < layers.length) {
    for (let index = winningIndex + 1; index < layers.length; index += 1) {
      const layer = layers[index] ?? {};
      const dropped = findCredential(layer);
      if (dropped !== null) {
        warnings.push(
          `${dropped} from ${labels[index]} is ignored; ${labels[winningIndex]} set a host credential`,
        );
      }
    }
    // Within-layer conflict: TOKIMEKI_TOKEN wins over TOKIMEKI_MASTER_TOKEN.
    const winner = layers[winningIndex] ?? {};
    if (
      typeof winner.TOKIMEKI_TOKEN === "string" &&
      winner.TOKIMEKI_TOKEN.length > 0 &&
      typeof winner.TOKIMEKI_MASTER_TOKEN === "string" &&
      winner.TOKIMEKI_MASTER_TOKEN.length > 0
    ) {
      warnings.push(
        "TOKIMEKI_TOKEN takes precedence over TOKIMEKI_MASTER_TOKEN; the master token is ignored",
      );
    }
  }

  // The envelope was expanded exactly once above; remove it so the loaders'
  // envelope stage cannot re-inject a credential the layer selection dropped.
  delete merged.TOKIMEKI_CONFIG;

  return { env: merged, file: file.info, warnings };
}

function pickFirstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}
