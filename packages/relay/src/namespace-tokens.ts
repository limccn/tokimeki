/**
 * Static multi-namespace host authentication (OSS).
 *
 * `TOKIMEKI_NAMESPACE_TOKENS` is a Worker secret containing a JSON object of
 * `{ "<namespace>": "<token>" }`. A host that presents a valid namespace token
 * gets host rights **only** for sessions named `<namespace>.<slug>`. The root
 * `TOKIMEKI_MASTER_TOKEN` stays the global break-glass credential.
 *
 * Parsing is fail-closed: any malformed entry disables namespace host auth
 * entirely instead of accepting a partial map. Tokens are never logged.
 */

import { constantTimeEqual } from "./crypto-utils.js";

/** Namespace names are lowercase DNS-label-like and at most 32 characters. */
export const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Each namespace token must be at least 32 bytes so it cannot be guessed. */
export const MIN_NAMESPACE_TOKEN_BYTES = 32;
/** Upper bound on configured namespaces; the Worker secret stays small. */
export const MAX_NAMESPACE_TOKENS = 64;
/** Upper bound on the raw JSON secret; larger values are rejected unparsed. */
export const MAX_NAMESPACE_TOKENS_RAW_BYTES = 16 * 1024;

export type NamespaceTokenConfigError =
  | "too_large"
  | "invalid_json"
  | "too_many_entries"
  | "invalid_namespace"
  | "invalid_token"
  | "token_too_short"
  | "duplicate_token"
  | "equals_master";

export interface NamespaceTokenEntry {
  readonly namespace: string;
  readonly token: string;
}

export interface NamespaceTokenConfig {
  readonly entries: readonly NamespaceTokenEntry[];
  /** Present when the configuration was rejected; `entries` is then empty. */
  readonly error?: NamespaceTokenConfigError;
}

const encoder = new TextEncoder();

interface NamespaceTokenFailure {
  readonly entries: readonly NamespaceTokenEntry[];
  readonly error: NamespaceTokenConfigError;
}

function fail(error: NamespaceTokenConfigError): NamespaceTokenFailure {
  return { entries: [], error };
}

/**
 * Parse and validate `TOKIMEKI_NAMESPACE_TOKENS`.
 *
 * `undefined`, empty, or whitespace-only values mean namespace host auth is
 * disabled (the pre-namespace master-only behavior). A returned `error`
 * means the whole map is rejected; the root master token still works.
 */
export function parseNamespaceTokens(
  raw: string | undefined,
  masterToken: string | undefined,
): NamespaceTokenConfig {
  if (raw === undefined || raw.trim().length === 0) {
    return { entries: [] };
  }
  if (encoder.encode(raw).byteLength > MAX_NAMESPACE_TOKENS_RAW_BYTES) {
    return fail("too_large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("invalid_json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("invalid_json");
  }
  const pairs = Object.entries(parsed as Record<string, unknown>);
  if (pairs.length > MAX_NAMESPACE_TOKENS) {
    return fail("too_many_entries");
  }
  const entries: NamespaceTokenEntry[] = [];
  const seenTokens = new Set<string>();
  for (const [namespace, token] of pairs) {
    if (!NAMESPACE_PATTERN.test(namespace)) {
      return fail("invalid_namespace");
    }
    if (typeof token !== "string" || token.length === 0) {
      return fail("invalid_token");
    }
    if (encoder.encode(token).byteLength < MIN_NAMESPACE_TOKEN_BYTES) {
      return fail("token_too_short");
    }
    if (masterToken !== undefined && masterToken.length > 0 && token === masterToken) {
      return fail("equals_master");
    }
    if (seenTokens.has(token)) {
      return fail("duplicate_token");
    }
    seenTokens.add(token);
    entries.push({ namespace, token });
  }
  return { entries };
}

/**
 * Resolve the namespace for a presented host token.
 *
 * Every entry is compared in constant time and the loop never exits early, so
 * response timing does not reveal which (or whether a later) token matched.
 * Returns `null` when the token belongs to no configured namespace.
 */
export async function matchNamespaceToken(
  presented: string,
  entries: readonly NamespaceTokenEntry[],
): Promise<string | null> {
  if (presented.length === 0 || entries.length === 0) {
    return null;
  }
  let matched: string | null = null;
  for (const entry of entries) {
    const equal = await constantTimeEqual(presented, entry.token);
    if (equal && matched === null) {
      matched = entry.namespace;
    }
  }
  return matched;
}

/**
 * True when `sessionId` is exactly `<namespace>.<slug>` with a non-empty slug.
 *
 * The Worker rejects anywhere else, and the SessionDO re-checks before it
 * trusts the internal `x-tokimeki-namespace` header.
 */
export function isNamespaceSessionId(sessionId: string, namespace: string): boolean {
  const prefix = `${namespace}.`;
  return sessionId.startsWith(prefix) && sessionId.length > prefix.length;
}

/**
 * Derive the namespace prefix of a session id, if it has one.
 *
 * Root hosts may create any valid session; `<namespace>.<slug>` records the
 * namespace for diagnostics and viewer prefix checks. Legacy/plain session
 * names (no dot, or an invalid prefix) return `null`.
 */
export function deriveNamespaceFromSessionId(sessionId: string): string | null {
  const dot = sessionId.indexOf(".");
  if (dot <= 0 || dot >= sessionId.length - 1) {
    return null;
  }
  const candidate = sessionId.slice(0, dot);
  return NAMESPACE_PATTERN.test(candidate) ? candidate : null;
}
