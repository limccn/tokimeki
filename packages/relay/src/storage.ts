/**
 * SQLite storage for the SessionDO.
 *
 * Session metadata and the reserved agent-coordination tables live in SQLite,
 * not KV. `ensureRelaySchema` is idempotent so it is safe to run lazily on the
 * first host hello and after a crash that leaves partially written data.
 */
export interface SessionMetadata {
  readonly sessionId: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly hostTokenHash: string;
  /** Host-offline grace TTL (`TOKIMEKI_SESSION_TTL_SECONDS`). */
  readonly sessionTtlSeconds: number;
  readonly maxClients: number;
  readonly hostOfflineDeadline: number | null;
  /**
   * Namespace recorded when the session was created. `null` marks a legacy or
   * root session without a `<namespace>.<slug>` prefix.
   */
  readonly namespaceId: string | null;
  /**
   * Epoch milliseconds at which the session lifetime ends regardless of host
   * activity (`TOKIMEKI_SESSION_MAX_TTL_SECONDS`); `null` means no absolute cap
   * (the feature is disabled or the legacy row has not seen a host hello yet).
   */
  readonly absoluteDeadline: number | null;
  /** Relay-delivered terminal bytes persisted for this session so far. */
  readonly relayBytes: number;
}

export interface HostExitRecord {
  readonly hostExitedAt: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/** Host-computed PBKDF2 verifier plus viewer/listener lockout state. */
export interface SessionPasscodeRecord {
  readonly kdf: string;
  readonly salt: string;
  readonly iterations: number;
  readonly hash: string;
  readonly failedAttempts: number;
  readonly lockedUntil: number | null;
  readonly updatedAt: number;
}

/**
 * Failed-auth counter scopes (v1.7).
 *
 * `opaque_token` covers viewer/listener session-token guesses on an existing
 * session; `passcode` covers per-IP passcode failures. Both live in one
 * bounded table so a session purge removes them with `deleteAll()`.
 */
export type AuthFailureKind = "opaque_token" | "passcode";

/** Per-IP failure counter row (never stores the raw client IP). */
export interface AuthFailureRecord {
  readonly failedAttempts: number;
  readonly windowStartedAt: number;
  readonly lockedUntil: number | null;
  readonly updatedAt: number;
}

/** Maximum per-IP rows kept per session and kind. */
export const AUTH_FAILURE_MAX_ROWS = 64;

export interface TurnCacheEntry {
  readonly payloadJson: string;
  readonly expiresAt: number;
}

export interface AgentIdempotencyRecord {
  readonly key: string;
  readonly op: string;
  readonly taskId: string | null;
  readonly firstSeenAt: number;
  readonly responseJson: string | null;
}

const AUTH_FAILURE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS session_auth_failures (
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    window_started_at INTEGER NOT NULL,
    locked_until INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, kind, ip_hash)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_session_auth_failures_updated
    ON session_auth_failures (session_id, kind, updated_at)`,
] as const;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS session_meta (
    session_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    host_token_hash TEXT NOT NULL,
    session_ttl_seconds INTEGER NOT NULL,
    max_clients INTEGER NOT NULL,
    host_offline_deadline INTEGER,
    namespace_id TEXT,
    absolute_deadline INTEGER,
    relay_bytes INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS session_passcode (
    session_id TEXT PRIMARY KEY,
    kdf TEXT NOT NULL,
    salt TEXT NOT NULL,
    iterations INTEGER NOT NULL,
    hash TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS session_lifecycle (
    session_id TEXT PRIMARY KEY,
    host_exited_at INTEGER NOT NULL,
    exit_code INTEGER,
    exit_signal TEXT
  )`,
  ...AUTH_FAILURE_SCHEMA_STATEMENTS,
  `CREATE TABLE IF NOT EXISTS turn_cache (
    provider TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agent_tasks (
    task_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    input_json TEXT NOT NULL,
    input_ref TEXT,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    deadline_at INTEGER,
    lease_id TEXT,
    runner_id TEXT,
    result_json TEXT,
    result_ref TEXT,
    error_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agent_leases (
    lease_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    runner_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    released_at INTEGER,
    release_reason TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS agent_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    task_id TEXT,
    runner_id TEXT,
    payload_json TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agent_runners (
    runner_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    capabilities_json TEXT,
    status TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS agent_idempotency (
    key TEXT PRIMARY KEY,
    op TEXT NOT NULL,
    task_id TEXT,
    first_seen_at INTEGER NOT NULL,
    response_json TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_tasks_claim
    ON agent_tasks (status, priority DESC, created_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_leases_expiry
    ON agent_leases (expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_events_session_seq
    ON agent_events (session_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runners_status
    ON agent_runners (status, last_seen_at)`,
] as const;

/**
 * Additive, idempotent column migration for `session_meta`.
 *
 * Tables created by older releases lack newer columns, and `CREATE TABLE IF
 * NOT EXISTS` does not add them. A fresh table already has every column, so
 * the duplicate-column error is expected and ignored.
 */
function tryAddColumn(sql: SqlStorage, column: string, definition: string): void {
  try {
    sql.exec(`ALTER TABLE session_meta ADD COLUMN ${column} ${definition}`);
  } catch {
    // Column already present (or the table was just created with it).
  }
}

/** Create the relay and reserved agent tables if they do not exist. */
export function ensureRelaySchema(sql: SqlStorage): void {
  for (const statement of SCHEMA_STATEMENTS) {
    sql.exec(statement);
  }
  tryAddColumn(sql, "namespace_id", "TEXT");
  tryAddColumn(sql, "absolute_deadline", "INTEGER");
  tryAddColumn(sql, "relay_bytes", "INTEGER NOT NULL DEFAULT 0");
}

/**
 * Narrow, idempotent schema creation for the failed-auth counter table.
 *
 * A viewer/listener hello may call this only after `session_meta` already
 * exists (SEC-01: never create schema for an arbitrary session id). The host
 * path creates it through `ensureRelaySchema`.
 */
export function ensureAuthFailureSchema(sql: SqlStorage): void {
  for (const statement of AUTH_FAILURE_SCHEMA_STATEMENTS) {
    sql.exec(statement);
  }
}

// A type alias (not an interface) so it satisfies SqlStorage's row-record
// constraint through the implicit index signature.
type SessionMetadataRow = {
  session_id: string;
  created_at: number;
  last_activity_at: number;
  host_token_hash: string;
  session_ttl_seconds: number;
  max_clients: number;
  host_offline_deadline: number | null;
  namespace_id: string | null;
  absolute_deadline: number | null;
  relay_bytes: number;
};

type PreQuotaSessionMetadataRow = Omit<SessionMetadataRow, "absolute_deadline" | "relay_bytes">;

type PreNamespaceSessionMetadataRow = Omit<PreQuotaSessionMetadataRow, "namespace_id">;

function mapSessionMetadataRow(
  row: SessionMetadataRow | PreQuotaSessionMetadataRow | PreNamespaceSessionMetadataRow,
): SessionMetadata {
  return {
    sessionId: row.session_id,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    hostTokenHash: row.host_token_hash,
    sessionTtlSeconds: row.session_ttl_seconds,
    maxClients: row.max_clients,
    hostOfflineDeadline: row.host_offline_deadline,
    namespaceId: "namespace_id" in row ? (row.namespace_id ?? null) : null,
    absoluteDeadline: "absolute_deadline" in row ? (row.absolute_deadline ?? null) : null,
    relayBytes: "relay_bytes" in row ? (row.relay_bytes ?? 0) : 0,
  };
}

/**
 * Load the single session metadata row, if the session exists.
 *
 * The additive migrations may not have run when an old DO wakes before its
 * next host `hello`, so the loader falls back through the historical column
 * lists. Missing columns are treated as defaults (`namespaceId: null`,
 * `absoluteDeadline: null`, `relayBytes: 0`).
 */
export function loadSessionMetadata(sql: SqlStorage): SessionMetadata | null {
  try {
    const rows = sql
      .exec<SessionMetadataRow>(
        `SELECT session_id, created_at, last_activity_at, host_token_hash,
                session_ttl_seconds, max_clients, host_offline_deadline,
                namespace_id, absolute_deadline, relay_bytes
           FROM session_meta
          LIMIT 1`,
      )
      .toArray();
    const row = rows[0];
    return row === undefined ? null : mapSessionMetadataRow(row);
  } catch {
    return loadPreQuotaSessionMetadata(sql);
  }
}

function loadPreQuotaSessionMetadata(sql: SqlStorage): SessionMetadata | null {
  try {
    const rows = sql
      .exec<PreQuotaSessionMetadataRow>(
        `SELECT session_id, created_at, last_activity_at, host_token_hash,
                session_ttl_seconds, max_clients, host_offline_deadline,
                namespace_id
           FROM session_meta
          LIMIT 1`,
      )
      .toArray();
    const row = rows[0];
    return row === undefined ? null : mapSessionMetadataRow(row);
  } catch {
    return loadPreNamespaceSessionMetadata(sql);
  }
}

function loadPreNamespaceSessionMetadata(sql: SqlStorage): SessionMetadata | null {
  try {
    const rows = sql
      .exec<PreNamespaceSessionMetadataRow>(
        `SELECT session_id, created_at, last_activity_at, host_token_hash,
                session_ttl_seconds, max_clients, host_offline_deadline
           FROM session_meta
          LIMIT 1`,
      )
      .toArray();
    const row = rows[0];
    return row === undefined ? null : mapSessionMetadataRow(row);
  } catch {
    // The table may have been removed by `deleteAll()`; treat as no session.
    return null;
  }
}

/**
 * Insert the session metadata row. `INSERT OR IGNORE` makes first-host
 * creation atomic: two concurrent first hellos cannot overwrite each other's
 * token hash/TTL/quotas; the loser re-reads and is rejected by the caller.
 */
export function insertSessionMetadata(sql: SqlStorage, meta: SessionMetadata): void {
  sql.exec(
    `INSERT OR IGNORE INTO session_meta
       (session_id, created_at, last_activity_at, host_token_hash,
        session_ttl_seconds, max_clients, host_offline_deadline, namespace_id,
        absolute_deadline, relay_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    meta.sessionId,
    meta.createdAt,
    meta.lastActivityAt,
    meta.hostTokenHash,
    meta.sessionTtlSeconds,
    meta.maxClients,
    meta.hostOfflineDeadline,
    meta.namespaceId,
    meta.absoluteDeadline,
    meta.relayBytes,
  );
}

/** Persist a new `lastActivityAt` value without rewriting the whole row. */
export function updateLastActivity(sql: SqlStorage, lastActivityAt: number): void {
  try {
    sql.exec("UPDATE session_meta SET last_activity_at = ?", lastActivityAt);
  } catch {
    // Session was deleted concurrently; nothing to update.
  }
}

/** Set or clear the host-offline grace deadline. */
export function setHostOfflineDeadline(sql: SqlStorage, deadline: number | null): void {
  try {
    sql.exec("UPDATE session_meta SET host_offline_deadline = ?", deadline);
  } catch {
    // Session was deleted concurrently; nothing to update.
  }
}

/** Set or clear the absolute session deadline. */
export function setAbsoluteDeadline(sql: SqlStorage, deadline: number | null): void {
  try {
    sql.exec("UPDATE session_meta SET absolute_deadline = ?", deadline);
  } catch {
    // Session was deleted concurrently; nothing to update.
  }
}

/**
 * Persist the session's relayed-byte total.
 *
 * The DO keeps the authoritative counter in memory and periodically writes the
 * total here, so this is an absolute set, not an increment. A hibernation
 * between flushes can lose up to one flush window.
 */
export function setRelayBytes(sql: SqlStorage, bytes: number): void {
  try {
    sql.exec("UPDATE session_meta SET relay_bytes = ?", Math.max(0, bytes));
  } catch {
    // Session was deleted concurrently; nothing to update.
  }
}

/**
 * Persist the host's explicit PTY exit so a viewer that reconnects (or joins
 * late) still learns the session ended. The row is cleared when a new host
 * takes over the session.
 */
export function saveHostExit(sql: SqlStorage, sessionId: string, exit: HostExitRecord): void {
  try {
    sql.exec(
      `INSERT OR REPLACE INTO session_lifecycle
         (session_id, host_exited_at, exit_code, exit_signal)
       VALUES (?, ?, ?, ?)`,
      sessionId,
      exit.hostExitedAt,
      exit.exitCode,
      exit.signal,
    );
  } catch {
    // Session was deleted concurrently; the broadcast has already happened.
  }
}

/** Load the persisted host exit, if the host has declared one. */
export function loadHostExit(sql: SqlStorage): HostExitRecord | null {
  try {
    const rows = sql
      .exec<{
        host_exited_at: number;
        exit_code: number | null;
        exit_signal: string | null;
      }>("SELECT host_exited_at, exit_code, exit_signal FROM session_lifecycle LIMIT 1")
      .toArray();
    const row = rows[0];
    if (row === undefined) return null;
    return {
      hostExitedAt: row.host_exited_at,
      exitCode: row.exit_code,
      signal: row.exit_signal,
    };
  } catch {
    return null;
  }
}

/** Clear the host-exit marker when a new host connects to the session. */
export function clearHostExit(sql: SqlStorage): void {
  try {
    sql.exec("DELETE FROM session_lifecycle");
  } catch {
    // Session was deleted concurrently; nothing to clear.
  }
}

/** Load the session passcode verifier and lockout counters, if configured. */
export function loadSessionPasscode(sql: SqlStorage): SessionPasscodeRecord | null {
  try {
    const rows = sql
      .exec<{
        kdf: string;
        salt: string;
        iterations: number;
        hash: string;
        failed_attempts: number;
        locked_until: number | null;
        updated_at: number;
      }>(
        `SELECT kdf, salt, iterations, hash, failed_attempts, locked_until, updated_at
           FROM session_passcode LIMIT 1`,
      )
      .toArray();
    const row = rows[0];
    if (row === undefined) return null;
    return {
      kdf: row.kdf,
      salt: row.salt,
      iterations: row.iterations,
      hash: row.hash,
      failedAttempts: row.failed_attempts,
      lockedUntil: row.locked_until ?? null,
      updatedAt: row.updated_at,
    };
  } catch (error) {
    // A legacy session may not have the table yet; anything else is a real
    // storage failure and must fail closed rather than admit a viewer.
    const message = error instanceof Error ? error.message : "";
    if (message.includes("no such table: session_passcode")) {
      return null;
    }
    throw error;
  }
}

/**
 * Store the verifier on the first host hello. `INSERT OR IGNORE` keeps a
 * concurrent/replayed host hello from rotating the verifier silently; the
 * caller compares the presented verifier against the stored one first.
 */
export function saveSessionPasscode(
  sql: SqlStorage,
  sessionId: string,
  verifier: {
    readonly kdf: string;
    readonly salt: string;
    readonly iterations: number;
    readonly hash: string;
  },
  now: number,
): void {
  sql.exec(
    `INSERT OR IGNORE INTO session_passcode
       (session_id, kdf, salt, iterations, hash, failed_attempts, locked_until, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, NULL, ?)`,
    sessionId,
    verifier.kdf,
    verifier.salt,
    verifier.iterations,
    verifier.hash,
    now,
  );
}

/** Persist a failed viewer/listener attempt and its optional lockout deadline. */
export function recordPasscodeFailure(
  sql: SqlStorage,
  sessionId: string,
  failedAttempts: number,
  lockedUntil: number | null,
  now: number,
): void {
  sql.exec(
    `UPDATE session_passcode
        SET failed_attempts = ?, locked_until = ?, updated_at = ?
      WHERE session_id = ?`,
    failedAttempts,
    lockedUntil,
    now,
    sessionId,
  );
}

/** Clear the lockout counters after a successful verification. */
export function clearPasscodeFailures(sql: SqlStorage, sessionId: string, now: number): void {
  sql.exec(
    `UPDATE session_passcode
        SET failed_attempts = 0, locked_until = NULL, updated_at = ?
      WHERE session_id = ?`,
    now,
    sessionId,
  );
}

/**
 * Load one per-IP failed-auth counter row, if present.
 *
 * The caller wraps this so a missing/broken table only disables locking and
 * never turns a wrong token into a successful verification.
 */
export function loadAuthFailure(
  sql: SqlStorage,
  sessionId: string,
  kind: AuthFailureKind,
  ipHash: string,
): AuthFailureRecord | null {
  const rows = sql
    .exec<{
      failed_attempts: number;
      window_started_at: number;
      locked_until: number | null;
      updated_at: number;
    }>(
      `SELECT failed_attempts, window_started_at, locked_until, updated_at
         FROM session_auth_failures
        WHERE session_id = ? AND kind = ? AND ip_hash = ?
        LIMIT 1`,
      sessionId,
      kind,
      ipHash,
    )
    .toArray();
  const row = rows[0];
  if (row === undefined) return null;
  return {
    failedAttempts: row.failed_attempts,
    windowStartedAt: row.window_started_at,
    lockedUntil: row.locked_until ?? null,
    updatedAt: row.updated_at,
  };
}

/** Insert or replace one per-IP failed-auth counter row. */
export function recordAuthFailure(
  sql: SqlStorage,
  record: {
    readonly sessionId: string;
    readonly kind: AuthFailureKind;
    readonly ipHash: string;
    readonly failedAttempts: number;
    readonly windowStartedAt: number;
    readonly lockedUntil: number | null;
    readonly updatedAt: number;
  },
): void {
  sql.exec(
    `INSERT OR REPLACE INTO session_auth_failures
       (session_id, kind, ip_hash, failed_attempts, window_started_at, locked_until, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    record.sessionId,
    record.kind,
    record.ipHash,
    record.failedAttempts,
    record.windowStartedAt,
    record.lockedUntil,
    record.updatedAt,
  );
}

/** Clear one per-IP failed-auth counter row after a successful verification. */
export function clearAuthFailure(
  sql: SqlStorage,
  sessionId: string,
  kind: AuthFailureKind,
  ipHash: string,
): void {
  sql.exec(
    "DELETE FROM session_auth_failures WHERE session_id = ? AND kind = ? AND ip_hash = ?",
    sessionId,
    kind,
    ipHash,
  );
}

/**
 * Bound the counter table for one `(session_id, kind)` scope.
 *
 * Expired, unlocked rows older than `windowMs` are deleted first; the remaining
 * rows are capped to the `AUTH_FAILURE_MAX_ROWS` newest IPs so a distributed
 * guessing source can never grow DO storage without bound.
 */
export function cleanupAuthFailures(
  sql: SqlStorage,
  sessionId: string,
  kind: AuthFailureKind,
  now: number,
  windowMs: number,
): void {
  sql.exec(
    `DELETE FROM session_auth_failures
      WHERE session_id = ? AND kind = ? AND updated_at <= ?
        AND (locked_until IS NULL OR locked_until <= ?)`,
    sessionId,
    kind,
    now - windowMs,
    now,
  );
  sql.exec(
    `DELETE FROM session_auth_failures
      WHERE session_id = ? AND kind = ?
        AND ip_hash NOT IN (
          SELECT ip_hash FROM session_auth_failures
           WHERE session_id = ? AND kind = ?
           ORDER BY updated_at DESC
           LIMIT ?
        )`,
    sessionId,
    kind,
    sessionId,
    kind,
    AUTH_FAILURE_MAX_ROWS,
  );
}

/**
 * Earliest future agent lease expiry, used only as an alarm input.
 *
 * v1 creates the tables but does not implement the claim runtime.
 */
export function nextAgentLeaseExpiry(sql: SqlStorage, after: number): number | null {
  try {
    const rows = sql
      .exec<{ next_expiry: number | null }>(
        `SELECT MIN(expires_at) AS next_expiry
           FROM agent_leases
          WHERE released_at IS NULL AND expires_at > ?`,
        after,
      )
      .toArray();
    const value = rows[0]?.next_expiry ?? null;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

/** Read cached Cloudflare TURN credentials if they are still fresh. */
export function readTurnCache(
  sql: SqlStorage,
  provider: string,
  freshAfter: number,
): TurnCacheEntry | null {
  try {
    const rows = sql
      .exec<{ payload_json: string; expires_at: number }>(
        "SELECT payload_json, expires_at FROM turn_cache WHERE provider = ? LIMIT 1",
        provider,
      )
      .toArray();
    const row = rows[0];
    if (row === undefined || row.expires_at <= freshAfter) {
      return null;
    }
    return { payloadJson: row.payload_json, expiresAt: row.expires_at };
  } catch {
    return null;
  }
}

/** Store cached Cloudflare TURN credentials across hibernation. */
export function writeTurnCache(sql: SqlStorage, entry: TurnCacheEntry): void {
  try {
    sql.exec(
      `INSERT OR REPLACE INTO turn_cache (provider, payload_json, expires_at)
       VALUES ('cloudflare', ?, ?)`,
      entry.payloadJson,
      entry.expiresAt,
    );
  } catch {
    // Caching is best-effort; credential issuance still succeeded.
  }
}

/**
 * Reserved idempotency lookup for future `agent.*` request handling.
 *
 * v1 exposes the skeleton only; the claim/complete runtime is not wired yet.
 */
export function findAgentIdempotency(sql: SqlStorage, key: string): AgentIdempotencyRecord | null {
  try {
    const rows = sql
      .exec<{
        key: string;
        op: string;
        task_id: string | null;
        first_seen_at: number;
        response_json: string | null;
      }>(
        `SELECT key, op, task_id, first_seen_at, response_json
           FROM agent_idempotency
          WHERE key = ?
          LIMIT 1`,
        key,
      )
      .toArray();
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      key: row.key,
      op: row.op,
      taskId: row.task_id,
      firstSeenAt: row.first_seen_at,
      responseJson: row.response_json,
    };
  } catch {
    return null;
  }
}

/** Reserved idempotency write for future `agent.*` request handling. */
export function recordAgentIdempotency(sql: SqlStorage, record: AgentIdempotencyRecord): void {
  sql.exec(
    `INSERT OR REPLACE INTO agent_idempotency
       (key, op, task_id, first_seen_at, response_json)
     VALUES (?, ?, ?, ?, ?)`,
    record.key,
    record.op,
    record.taskId,
    record.firstSeenAt,
    record.responseJson,
  );
}
