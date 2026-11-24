/**
 * Explicit, user-confirmed config/history persistence (v1.4-E).
 *
 * This is the one deliberate exception to the historical "CLI never writes
 * ~/.tokimeki" rule: only wizard/menu actions call these functions. Both files
 * are 0600, atomically replaced, and refuse symlinks or insecure existing
 * permissions. Error messages name paths/keys, never values.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { ConfigError } from "./config.js";
import { CONFIG_FILE_MAX_BYTES, checkSecretFilePermissions } from "./config-file.js";

export const USER_CONFIG_PATH = [".tokimeki", "config.json"] as const;
export const HISTORY_FILE_NAME = "history.json";
export const HISTORY_MAX_ENTRIES = 20;
export const MAX_HISTORY_BYTES = 256 * 1024;

/** The only keys a wizard may persist into ~/.tokimeki/config.json. */
export const CONFIG_WRITE_KEYS = [
  "TOKIMEKI_RELAY_URL",
  "TOKIMEKI_NAMESPACE",
  "TOKIMEKI_TOKEN",
  "TOKIMEKI_SESSION",
  "TOKIMEKI_SESSION_TOKEN",
] as const;

export type ConfigWriteKey = (typeof CONFIG_WRITE_KEYS)[number];

export interface ConfigWriteInput {
  readonly relayUrl?: string;
  readonly namespace?: string;
  readonly token?: string;
  readonly session?: string;
  readonly sessionToken?: string;
}

export interface HistoryEntry {
  readonly relayUrl: string;
  readonly namespace?: string;
  readonly session: string;
  readonly sessionToken?: string;
  readonly lastUsedAt: number;
  readonly label?: string;
}

export interface PersistOptions {
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  /** Explicitly allow a JWT-shaped session token (hosted short-lived credential). */
  readonly allowJwtSessionToken?: boolean;
  /** Override "now" for deterministic tests. */
  readonly now?: () => number;
}

export interface WriteResult {
  readonly path: string;
  readonly warnings: readonly string[];
}

/**
 * A hosted Session JWT is three non-empty dot-separated base64url segments.
 * It is a short-lived credential and must never be persisted by default.
 */
export function looksLikeJwt(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 3 && parts.every((part) => part.length > 0 && /^[A-Za-z0-9_-]+$/.test(part))
  );
}

function userDir(options: PersistOptions): string {
  return join(options.homeDir ?? homedir(), ".tokimeki");
}

function configPath(options: PersistOptions): string {
  return join(userDir(options), ...USER_CONFIG_PATH.slice(1));
}

function historyPath(options: PersistOptions): string {
  return join(userDir(options), HISTORY_FILE_NAME);
}

function describeErrorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "unknown";
}

function readJsonObject(
  path: string,
  maxBytes: number,
  platform: NodeJS.Platform,
): Record<string, unknown> | null {
  let stats: import("node:fs").Stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (describeErrorCode(error) === "ENOENT") return null;
    throw new ConfigError(`unable to read ${path}: ${describeErrorCode(error)}`);
  }
  if (stats.isSymbolicLink()) {
    throw new ConfigError(`${path} must not be a symbolic link`);
  }
  if (!stats.isFile()) {
    throw new ConfigError(`${path} is not a regular file`);
  }
  if (stats.size > maxBytes) {
    throw new ConfigError(`${path} is larger than ${maxBytes} bytes`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`unable to read ${path}: ${describeErrorCode(error)}`);
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
  // Existing config files that still hold credentials must already be 0600;
  // never silently chmod or rewrite an insecure file.
  const envLike: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") envLike[key] = value;
  }
  assertSecretPermissions(path, stats.mode, envLike, platform);
  return parsed as Record<string, unknown>;
}

function assertSecretPermissions(
  path: string,
  mode: number,
  envLike: Record<string, string>,
  platform: NodeJS.Platform,
): readonly string[] {
  const hasSecret = Object.entries(envLike).some(
    ([key, value]) =>
      key.startsWith("TOKIMEKI_") &&
      value.length > 0 &&
      (key.includes("TOKEN") ||
        key.includes("SECRET") ||
        key.includes("PASSCODE") ||
        key.includes("CREDENTIAL")),
  );
  if (!hasSecret) return [];
  const verdict = checkSecretFilePermissions(mode, platform);
  if (verdict === "insecure") {
    throw new ConfigError(
      `${path} must be 0600 when it contains credentials (run: chmod 600 ${path})`,
    );
  }
  if (verdict === "not-enforced") {
    return [`${basename(path)} permissions are not enforced on Windows; keep ${path} private`];
  }
  return [];
}

function sleepSync(milliseconds: number): void {
  // Atomics.wait is the portable synchronous sleep in Node without spawning.
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, milliseconds);
}

/** Serialize writers with an exclusive lockfile next to the target. */
function withFileLock<T>(targetPath: string, action: () => T): T {
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + 2_000;
  let fd: number | null = null;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      const code = describeErrorCode(error);
      if (code !== "EEXIST") {
        throw new ConfigError(`unable to lock ${targetPath}: ${code}`);
      }
      // A stale lock (crashed writer) is reclaimed after 30 seconds.
      try {
        const stats = statSync(lockPath);
        if (Date.now() - stats.mtimeMs > 30_000) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new ConfigError(`timed out waiting for the config lock at ${lockPath}`);
      }
      sleepSync(25);
    }
  }
  try {
    writeSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
  } catch {
    // Lock content is diagnostic only.
  } finally {
    closeSync(fd);
  }
  try {
    return action();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // best effort
    }
  }
}

/**
 * Atomic 0600 write: same-directory temp file -> fsync -> rename.
 * The directory itself is created 0700 when missing.
 */
function atomicWriteJson(path: string, value: unknown, platform: NodeJS.Platform): string[] {
  const dir = dirname(path);
  const warnings: string[] = [];
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new ConfigError(`unable to create ${dir}: ${describeErrorCode(error)}`);
  }
  const tempPath = join(
    dir,
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let fd: number | null = null;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    // POSIX rename replaces the destination atomically; Windows uses
    // MOVEFILE_REPLACE_EXISTING via libuv, which also replaces.
    renameSync(tempPath, path);
    if (platform !== "win32") {
      try {
        const dirFd = openSync(dir, "r");
        try {
          fsyncSync(dirFd);
        } finally {
          closeSync(dirFd);
        }
      } catch {
        // Directory fsync is best effort.
      }
      try {
        chmodSync(path, 0o600);
      } catch {
        // openSync already created it 0600; keep best-effort.
      }
    } else {
      warnings.push(
        `file permissions are not enforced on Windows; keep ${path} private and delete it when done`,
      );
    }
  } catch (error) {
    throw new ConfigError(`unable to write ${path}: ${describeErrorCode(error)}`);
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // temp file may already have been renamed away
    }
  }
  return warnings;
}

/**
 * Write the wizard-approved config subset, merging into the existing file.
 *
 * Unknown keys are preserved. Only `CONFIG_WRITE_KEYS` may be written; a
 * JWT-shaped `TOKIMEKI_SESSION_TOKEN` is rejected unless the caller explicitly
 * opts in for an opaque OSS token.
 */
function ensureParentDirectory(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new ConfigError(`unable to create ${dirname(path)}: ${describeErrorCode(error)}`);
  }
}

export function writeUserConfig(
  input: ConfigWriteInput,
  options: PersistOptions = {},
): WriteResult {
  const platform = options.platform ?? process.platform;
  if (
    input.sessionToken !== undefined &&
    looksLikeJwt(input.sessionToken) &&
    options.allowJwtSessionToken !== true
  ) {
    throw new ConfigError(
      "TOKIMEKI_SESSION_TOKEN looks like a hosted Session JWT; short-lived Session JWTs must not be persisted",
    );
  }
  const path = configPath(options);
  ensureParentDirectory(path);
  const values: Partial<Record<ConfigWriteKey, string>> = {
    TOKIMEKI_RELAY_URL: input.relayUrl,
    TOKIMEKI_NAMESPACE: input.namespace,
    TOKIMEKI_TOKEN: input.token,
    TOKIMEKI_SESSION: input.session,
    TOKIMEKI_SESSION_TOKEN: input.sessionToken,
  };
  return withFileLock(path, () => {
    const existing = readJsonObject(path, CONFIG_FILE_MAX_BYTES, platform) ?? {};
    const merged: Record<string, unknown> = { ...existing };
    for (const key of CONFIG_WRITE_KEYS) {
      const value = values[key];
      if (value === undefined) continue;
      if (value.length === 0) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
    const warnings = atomicWriteJson(path, merged, platform);
    return { path, warnings };
  });
}

/** Read the full user config (callers treat it as the existing read layer). */
export function readUserConfigRaw(options: PersistOptions = {}): Record<string, unknown> | null {
  return readJsonObject(
    configPath(options),
    CONFIG_FILE_MAX_BYTES,
    options.platform ?? process.platform,
  );
}

function normalizeHistoryEntry(value: unknown, path: string): HistoryEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const relayUrl = record.relayUrl;
  const session = record.session;
  const lastUsedAt = record.lastUsedAt;
  if (typeof relayUrl !== "string" || relayUrl.length === 0) return null;
  if (typeof session !== "string" || session.length === 0) return null;
  if (typeof lastUsedAt !== "number" || !Number.isFinite(lastUsedAt)) return null;
  const namespace = typeof record.namespace === "string" ? record.namespace : undefined;
  const sessionToken = typeof record.sessionToken === "string" ? record.sessionToken : undefined;
  const label = typeof record.label === "string" ? record.label : undefined;
  void path;
  return {
    relayUrl,
    session,
    lastUsedAt,
    ...(namespace === undefined ? {} : { namespace }),
    ...(sessionToken === undefined ? {} : { sessionToken }),
    ...(label === undefined ? {} : { label }),
  };
}

export interface HistoryReadResult {
  readonly path: string;
  readonly entries: readonly HistoryEntry[];
  readonly warnings: readonly string[];
}

export function readHistory(options: PersistOptions = {}): HistoryReadResult {
  const platform = options.platform ?? process.platform;
  const path = historyPath(options);
  let stats: import("node:fs").Stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (describeErrorCode(error) === "ENOENT") {
      return { path, entries: [], warnings: [] };
    }
    throw new ConfigError(`unable to read ${path}: ${describeErrorCode(error)}`);
  }
  if (stats.isSymbolicLink()) {
    throw new ConfigError(`${path} must not be a symbolic link`);
  }
  if (!stats.isFile()) {
    throw new ConfigError(`${path} is not a regular file`);
  }
  if (stats.size > MAX_HISTORY_BYTES) {
    throw new ConfigError(`${path} is larger than ${MAX_HISTORY_BYTES} bytes`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`unable to read ${path}: ${describeErrorCode(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${path} must contain valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new ConfigError(`${path} must contain a JSON array`);
  }
  const entries: HistoryEntry[] = [];
  for (const value of parsed) {
    const entry = normalizeHistoryEntry(value, path);
    if (entry !== null) entries.push(entry);
  }
  const warnings: string[] = [];
  if (entries.some((entry) => entry.sessionToken !== undefined)) {
    const verdict = checkSecretFilePermissions(stats.mode, platform);
    if (verdict === "insecure") {
      throw new ConfigError(
        `${path} must be 0600 when it contains session tokens (run: chmod 600 ${path})`,
      );
    }
    if (verdict === "not-enforced") {
      warnings.push(`history permissions are not enforced on Windows; keep ${path} private`);
    }
  }
  return { path, entries, warnings };
}

function sortAndLimit(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return [...entries]
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
    .slice(0, HISTORY_MAX_ENTRIES);
}

function writeHistory(entries: readonly HistoryEntry[], options: PersistOptions): WriteResult {
  const platform = options.platform ?? process.platform;
  const path = historyPath(options);
  ensureParentDirectory(path);
  return withFileLock(path, () => {
    const warnings = atomicWriteJson(path, sortAndLimit(entries), platform);
    return { path, warnings };
  });
}

/**
 * Insert/update a history entry. Dedupe key is relayUrl+session; the list is
 * LRU-capped at 20. `sessionToken` is optional and never a hosted Session JWT.
 */
export function addHistoryEntry(
  entry: Omit<HistoryEntry, "lastUsedAt"> & { readonly lastUsedAt?: number },
  options: PersistOptions = {},
): WriteResult {
  if (
    entry.sessionToken !== undefined &&
    looksLikeJwt(entry.sessionToken) &&
    options.allowJwtSessionToken !== true
  ) {
    throw new ConfigError(
      "the session token looks like a hosted Session JWT; it must not be written to history",
    );
  }
  const existing = readHistory(options).entries;
  const lastUsedAt = entry.lastUsedAt ?? (options.now ?? Date.now)();
  const filtered = existing.filter(
    (item) => !(item.relayUrl === entry.relayUrl && item.session === entry.session),
  );
  const next: HistoryEntry = {
    relayUrl: entry.relayUrl,
    session: entry.session,
    lastUsedAt,
    ...(entry.namespace === undefined ? {} : { namespace: entry.namespace }),
    ...(entry.sessionToken === undefined ? {} : { sessionToken: entry.sessionToken }),
    ...(entry.label === undefined ? {} : { label: entry.label }),
  };
  return writeHistory([next, ...filtered], options);
}

export function removeHistoryEntry(
  session: string,
  options: PersistOptions & { readonly relayUrl?: string } = {},
): WriteResult {
  const existing = readHistory(options).entries;
  const filtered = existing.filter(
    (item) =>
      !(
        item.session === session &&
        (options.relayUrl === undefined || item.relayUrl === options.relayUrl)
      ),
  );
  return writeHistory(filtered, options);
}

export function clearHistory(options: PersistOptions = {}): WriteResult {
  return writeHistory([], options);
}
