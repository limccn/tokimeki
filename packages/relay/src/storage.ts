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
  readonly sessionTtlSeconds: number;
  readonly maxClients: number;
  readonly hostOfflineDeadline: number | null;
}

export interface HostExitRecord {
  readonly hostExitedAt: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

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

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS session_meta (
    session_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    host_token_hash TEXT NOT NULL,
    session_ttl_seconds INTEGER NOT NULL,
    max_clients INTEGER NOT NULL,
    host_offline_deadline INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS session_lifecycle (
    session_id TEXT PRIMARY KEY,
    host_exited_at INTEGER NOT NULL,
    exit_code INTEGER,
    exit_signal TEXT
  )`,
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

/** Create the relay and reserved agent tables if they do not exist. */
export function ensureRelaySchema(sql: SqlStorage): void {
  for (const statement of SCHEMA_STATEMENTS) {
    sql.exec(statement);
  }
}

/** Load the single session metadata row, if the session exists. */
export function loadSessionMetadata(sql: SqlStorage): SessionMetadata | null {
  try {
    const rows = sql
      .exec<{
        session_id: string;
        created_at: number;
        last_activity_at: number;
        host_token_hash: string;
        session_ttl_seconds: number;
        max_clients: number;
        host_offline_deadline: number | null;
      }>(
        `SELECT session_id, created_at, last_activity_at, host_token_hash,
                session_ttl_seconds, max_clients, host_offline_deadline
           FROM session_meta
          LIMIT 1`,
      )
      .toArray();
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      sessionId: row.session_id,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      hostTokenHash: row.host_token_hash,
      sessionTtlSeconds: row.session_ttl_seconds,
      maxClients: row.max_clients,
      hostOfflineDeadline: row.host_offline_deadline,
    };
  } catch {
    // The table may have been removed by `deleteAll()`; treat as no session.
    return null;
  }
}

/** Insert or replace the session metadata row (a session has at most one). */
export function insertSessionMetadata(sql: SqlStorage, meta: SessionMetadata): void {
  sql.exec(
    `INSERT OR REPLACE INTO session_meta
       (session_id, created_at, last_activity_at, host_token_hash,
        session_ttl_seconds, max_clients, host_offline_deadline)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    meta.sessionId,
    meta.createdAt,
    meta.lastActivityAt,
    meta.hostTokenHash,
    meta.sessionTtlSeconds,
    meta.maxClients,
    meta.hostOfflineDeadline,
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
