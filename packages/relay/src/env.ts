import type { IceTransportPolicy } from "@limccn/tokimeki-protocol";

/** coturn URL configuration: JSON string array or legacy comma-separated string. */
export type CoturnUrlConfig = string | readonly string[];

/**
 * Environment bindings for the tokimeki relay Worker and SessionDO.
 *
 * Secrets are provided with `wrangler secret put`:
 * - `TOKIMEKI_MASTER_TOKEN`
 * - `TOKIMEKI_NAMESPACE_TOKENS`
 * - `TOKIMEKI_COTURN_SECRET`
 * - `TOKIMEKI_TURN_API_TOKEN`
 *
 * Everything else may live in `wrangler.jsonc` `vars`. No secret is ever
 * included in a response, URL, or log record.
 */
export interface RelayEnv {
  readonly SESSIONS: DurableObjectNamespace;
  readonly TOKIMEKI_MASTER_TOKEN?: string;
  /** JSON object `{ "<namespace>": "<token>" }` for static namespace hosts. */
  readonly TOKIMEKI_NAMESPACE_TOKENS?: string;
  readonly TOKIMEKI_SESSION_TTL_SECONDS?: string;
  /** Absolute session lifetime from `created_at` in seconds (0 = off). */
  readonly TOKIMEKI_SESSION_MAX_TTL_SECONDS?: string;
  /** Inactivity lifetime from `last_activity_at` in seconds (0 = off). */
  readonly TOKIMEKI_SESSION_IDLE_TTL_SECONDS?: string;
  /** Relay-delivered terminal bytes allowed per session (0 = off). */
  readonly TOKIMEKI_SESSION_MAX_BYTES?: string;
  /** Inbound WebSocket messages per second per session (0 = off). */
  readonly TOKIMEKI_SESSION_MAX_MESSAGES_PER_SECOND?: string;
  readonly TOKIMEKI_MAX_CLIENTS_PER_SESSION?: string;
  /** Independent limit for read-only listeners (default 8). */
  readonly TOKIMEKI_MAX_LISTENERS?: string;
  /**
   * Optional Cloudflare rate-limit binding for `/ws` WebSocket upgrade
   * attempts (v1.7 R1). The policy lives in `[[ratelimits]]` in the Wrangler
   * config, never in code. Missing binding = fail-open with an error log.
   */
  readonly TOKIMEKI_WS_IP_LIMIT?: RateLimit;
  readonly TOKIMEKI_STUN_URLS?: string;
  readonly TOKIMEKI_TURN_PROVIDER?: string;
  readonly TOKIMEKI_COTURN_URLS?: CoturnUrlConfig;
  readonly TOKIMEKI_COTURN_SECRET?: string;
  readonly TOKIMEKI_COTURN_TTL_SECONDS?: string;
  readonly TOKIMEKI_TURN_URLS?: string;
  readonly TOKIMEKI_TURN_USERNAME?: string;
  readonly TOKIMEKI_TURN_CREDENTIAL?: string;
  readonly TOKIMEKI_TURN_KEY_ID?: string;
  readonly TOKIMEKI_TURN_API_TOKEN?: string;
  readonly TOKIMEKI_TURN_TTL_SECONDS?: string;
  readonly TOKIMEKI_ICE_TRANSPORT_POLICY?: string;
  /**
   * Host JWT verification (all optional; unset `TOKIMEKI_JWT_JWKS_URL` =
   * JWT mode disabled). The JWKS lives on the TokiAPI dashboard origin
   * (`https://<dashboard>/api/tokimeki/jwks.json`), never on the relay.
   */
  readonly TOKIMEKI_JWT_JWKS_URL?: string;
  /** Required when the JWKS URL is set; compared exactly against `iss`. */
  readonly TOKIMEKI_JWT_ISSUER?: string;
  /** Defaults to `tokimeki-relay` when the JWKS URL is set. */
  readonly TOKIMEKI_JWT_AUDIENCE?: string;
  readonly TOKIMEKI_JWT_JWKS_TTL_SECONDS?: string;
  readonly TOKIMEKI_JWT_CLOCK_SKEW_SECONDS?: string;
  /**
   * Test-only escape hatch: `1` accepts an `http://` JWKS URL when the host is
   * loopback (`localhost`/`127.0.0.1`/`[::1]`). Used by the local cross-repo
   * e2e harness; production deployments must leave this unset.
   */
  readonly TOKIMEKI_JWT_ALLOW_HTTP?: string;
  readonly TOKIMEKI_LOG_LEVEL?: string;
}

export const DEFAULT_SESSION_TTL_SECONDS = 86_400;
/** Absolute session lifetime default (24h); 0 disables the cap. */
export const DEFAULT_SESSION_MAX_TTL_SECONDS = 86_400;
/** Upper bound on configurable session TTLs (30 days). */
export const MAX_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const DEFAULT_MAX_CLIENTS_PER_SESSION = 8;
export const DEFAULT_MAX_LISTENERS = 8;
export const DEFAULT_STUN_URLS = "stun:stun.cloudflare.com:3478";

/** Parse a positive integer environment value, falling back on invalid input. */
export function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw.trim(), 10);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(Math.trunc(value), maximum);
}

/**
 * Parse a non-negative integer environment value.
 *
 * `0` is meaningful for the session limits (it disables the limiter), so it is
 * preserved instead of falling back. Negative, empty, and non-numeric values
 * fall back to the default; values above `maximum` are clamped.
 */
export function parseNonNegativeInt(
  raw: string | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw.trim(), 10);
  const value = Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  return Math.min(Math.trunc(value), maximum);
}

/** Session TTL in seconds (`TOKIMEKI_SESSION_TTL_SECONDS`, default 24h). */
export function sessionTtlSeconds(env: RelayEnv): number {
  return parsePositiveInt(env.TOKIMEKI_SESSION_TTL_SECONDS, DEFAULT_SESSION_TTL_SECONDS);
}

/**
 * Absolute session lifetime in seconds from `created_at`
 * (`TOKIMEKI_SESSION_MAX_TTL_SECONDS`, default 24h, `0` = no absolute cap).
 */
export function sessionMaxTtlSeconds(env: {
  readonly TOKIMEKI_SESSION_MAX_TTL_SECONDS?: string;
}): number {
  return parseNonNegativeInt(
    env.TOKIMEKI_SESSION_MAX_TTL_SECONDS,
    DEFAULT_SESSION_MAX_TTL_SECONDS,
    MAX_SESSION_TTL_SECONDS,
  );
}

/**
 * Idle session lifetime in seconds from `last_activity_at`
 * (`TOKIMEKI_SESSION_IDLE_TTL_SECONDS`, default 0 = off).
 */
export function sessionIdleTtlSeconds(env: {
  readonly TOKIMEKI_SESSION_IDLE_TTL_SECONDS?: string;
}): number {
  return parseNonNegativeInt(env.TOKIMEKI_SESSION_IDLE_TTL_SECONDS, 0, MAX_SESSION_TTL_SECONDS);
}

/**
 * Relay-delivered terminal bytes allowed per session
 * (`TOKIMEKI_SESSION_MAX_BYTES`, default 0 = off).
 */
export function sessionMaxBytes(env: { readonly TOKIMEKI_SESSION_MAX_BYTES?: string }): number {
  return parseNonNegativeInt(env.TOKIMEKI_SESSION_MAX_BYTES, 0);
}

/**
 * Inbound WebSocket messages per second allowed for an active session
 * (`TOKIMEKI_SESSION_MAX_MESSAGES_PER_SECOND`, default 0 = off).
 */
export function sessionMaxMessagesPerSecond(env: {
  readonly TOKIMEKI_SESSION_MAX_MESSAGES_PER_SECOND?: string;
}): number {
  return parseNonNegativeInt(env.TOKIMEKI_SESSION_MAX_MESSAGES_PER_SECOND, 0);
}

/** Maximum active clients per session (`TOKIMEKI_MAX_CLIENTS_PER_SESSION`, default 8). */
export function maxClientsPerSession(env: RelayEnv): number {
  return parsePositiveInt(env.TOKIMEKI_MAX_CLIENTS_PER_SESSION, DEFAULT_MAX_CLIENTS_PER_SESSION);
}

/**
 * Maximum concurrent read-only listeners per session
 * (`TOKIMEKI_MAX_LISTENERS`, default 8).
 *
 * Listeners also count toward `TOKIMEKI_MAX_CLIENTS_PER_SESSION`; this is an
 * additional cap that keeps a snapshot fan-out from crowding out viewers.
 */
export function maxListenersPerSession(env: RelayEnv): number {
  return parsePositiveInt(env.TOKIMEKI_MAX_LISTENERS, DEFAULT_MAX_LISTENERS);
}

/**
 * Shape-check the optional `TOKIMEKI_WS_IP_LIMIT` binding.
 *
 * Wrangler `vars` are plain strings, so a var accidentally named like the
 * binding must not crash every upgrade. An absent or malformed binding means
 * the per-IP edge limit is disabled (fail-open, logged by the Worker).
 */
export function wsIpRateLimit(env: Pick<RelayEnv, "TOKIMEKI_WS_IP_LIMIT">): RateLimit | undefined {
  const binding: unknown = env.TOKIMEKI_WS_IP_LIMIT;
  if (
    typeof binding === "object" &&
    binding !== null &&
    typeof (binding as { limit?: unknown }).limit === "function"
  ) {
    return binding as RateLimit;
  }
  return undefined;
}

/** ICE transport policy advertised in `welcome`; defaults to `all`. */
export function iceTransportPolicy(env: RelayEnv): IceTransportPolicy {
  return env.TOKIMEKI_ICE_TRANSPORT_POLICY === "relay" ? "relay" : "all";
}

/** Comma-separated STUN URL list, always containing at least one entry. */
export function stunUrlList(env: { readonly TOKIMEKI_STUN_URLS?: string }): string[] {
  const urls = (env.TOKIMEKI_STUN_URLS ?? DEFAULT_STUN_URLS)
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return urls.length > 0 ? urls : [DEFAULT_STUN_URLS];
}

/**
 * Raw coturn URL entries.
 *
 * Arrays are used as-is. A string starting with `[` is parsed as JSON first so
 * a runtime that stringifies JSON vars still works; any other string (or a
 * failed parse) falls back to the legacy comma-separated form.
 */
function coturnUrlCandidates(raw: CoturnUrlConfig): unknown[] {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // Not valid JSON; fall through to the legacy comma-separated form.
      }
    }
    return trimmed.split(",");
  }
  if (!Array.isArray(raw)) {
    // Wrangler vars are untyped JSON: a non-array value is treated as unset so
    // `hello` falls back instead of throwing before provider selection.
    return [];
  }
  return [...raw];
}

/**
 * Normalized coturn TURN URL list (`TOKIMEKI_COTURN_URLS`).
 *
 * Accepts a JSON array, a JSON-encoded array string, or the legacy
 * comma-separated string. Entries are trimmed; empty, non-string, duplicate,
 * and non `turn:`/`turns:` entries are dropped. Order of first occurrence is
 * preserved. An empty result means coturn REST is not configured.
 */
export function coturnUrlList(env: { readonly TOKIMEKI_COTURN_URLS?: CoturnUrlConfig }): string[] {
  const raw = env.TOKIMEKI_COTURN_URLS;
  if (raw === undefined) {
    return [];
  }
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const entry of coturnUrlCandidates(raw)) {
    if (typeof entry !== "string") {
      continue;
    }
    const url = entry.trim();
    if (url.length === 0 || seen.has(url) || !/^turns?:/i.test(url)) {
      continue;
    }
    seen.add(url);
    urls.push(url);
  }
  return urls;
}
