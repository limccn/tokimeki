/**
 * Host JWT verification (ES256, offline at the Worker edge).
 *
 * TokiAPI issues Host JWTs (`token_use=host`, `scope` containing `host`,
 * `namespace` = the first 5 chars of the user's namespace id) and publishes a
 * public JWKS on its dashboard origin. The relay verifies tokens offline: it
 * fetches and caches the JWKS per isolate and never calls TokiAPI per
 * connection.
 *
 * JWT mode is disabled unless `TOKIMEKI_JWT_JWKS_URL` is set. With the mode
 * disabled, self-host deployments keep their exact pre-JWT request handling:
 * no token shape detection, no Authorization parsing, no JWKS traffic.
 *
 * Nothing in this module ever logs or embeds a token, a header value, key
 * material, or a JWKS body.
 */

import { parseNonNegativeInt, type RelayEnv } from "./env.js";
import { NAMESPACE_PATTERN } from "./namespace-tokens.js";

/** Hard cap on a presented JWT value (header safety; matches the CLI guard). */
export const MAX_JWT_LENGTH = 8192;
/** Hard cap on the JWKS response body. */
export const MAX_JWKS_BYTES = 64 * 1024;
/** Maximum number of keys accepted in one JWKS document. */
export const MAX_JWKS_KEYS = 32;
/** Maximum cached JWKS URLs per isolate (operators configure one or two). */
const MAX_JWKS_CACHE_URLS = 4;
/** Minimum interval between forced JWKS fetches (unknown kid / failure retry). */
export const JWKS_REFRESH_MIN_INTERVAL_MS = 30_000;
/** Outbound JWKS fetch timeout. */
const JWKS_FETCH_TIMEOUT_MS = 5_000;
/** Maximum `kid` length accepted in a JWT header or a JWKS document. */
const MAX_KID_LENGTH = 128;
/** Maximum `iss` length. */
const MAX_ISSUER_LENGTH = 512;
/** Maximum `aud` length. */
const MAX_AUDIENCE_LENGTH = 256;
export const DEFAULT_JWT_AUDIENCE = "tokimeki-relay";
const DEFAULT_JWKS_TTL_SECONDS = 3600;
const MIN_JWKS_TTL_SECONDS = 60;
const MAX_JWKS_TTL_SECONDS = 86_400;
const DEFAULT_CLOCK_SKEW_SECONDS = 60;
const MAX_CLOCK_SKEW_SECONDS = 300;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type JwtConfigError = "invalid_url" | "missing_issuer";

export interface JwtAuthConfig {
  readonly jwksUrl: string;
  readonly issuer: string;
  readonly audience: string;
  readonly jwksTtlSeconds: number;
  readonly clockSkewSeconds: number;
}

export type JwtConfigStatus =
  | { readonly status: "disabled" }
  | { readonly status: "invalid"; readonly reason: JwtConfigError }
  | { readonly status: "enabled"; readonly config: JwtAuthConfig };

/**
 * Resolve JWT mode from the environment.
 *
 * `TOKIMEKI_JWT_JWKS_URL` unset/blank means disabled regardless of the other
 * variables. A malformed URL or a missing issuer produces `invalid`; JWT
 * credentials then fail closed while fallback/namespace tokens keep working.
 * TTL/skew typos clamp to their defaults instead of disabling authentication.
 */
export function readJwtAuthConfig(env: RelayEnv): JwtConfigStatus {
  const rawUrl = env.TOKIMEKI_JWT_JWKS_URL;
  if (rawUrl === undefined || rawUrl.trim().length === 0) {
    return { status: "disabled" };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { status: "invalid", reason: "invalid_url" };
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    return { status: "invalid", reason: "invalid_url" };
  }
  const issuerRaw = env.TOKIMEKI_JWT_ISSUER;
  const issuer = issuerRaw?.trim() ?? "";
  if (issuer.length === 0 || issuer.length > MAX_ISSUER_LENGTH) {
    return { status: "invalid", reason: "missing_issuer" };
  }
  const audienceRaw = env.TOKIMEKI_JWT_AUDIENCE?.trim() ?? "";
  const audience =
    audienceRaw.length === 0 ? DEFAULT_JWT_AUDIENCE : audienceRaw.slice(0, MAX_AUDIENCE_LENGTH);
  const jwksTtlSeconds = Math.max(
    MIN_JWKS_TTL_SECONDS,
    Math.min(
      MAX_JWKS_TTL_SECONDS,
      parseNonNegativeInt(env.TOKIMEKI_JWT_JWKS_TTL_SECONDS, DEFAULT_JWKS_TTL_SECONDS),
    ),
  );
  const clockSkewSeconds = Math.min(
    MAX_CLOCK_SKEW_SECONDS,
    parseNonNegativeInt(env.TOKIMEKI_JWT_CLOCK_SKEW_SECONDS, DEFAULT_CLOCK_SKEW_SECONDS),
  );
  return {
    status: "enabled",
    config: { jwksUrl: parsed.toString(), issuer, audience, jwksTtlSeconds, clockSkewSeconds },
  };
}

// Per-isolate config cache keyed by the raw env values, mirroring the
// namespace-token cache: an invalid configuration is logged once per value
// instead of on every request.
let cachedJwtConfig: JwtConfigStatus | null = null;
let cachedJwtConfigKey: string | null = null;

function jwtConfigCacheKey(env: RelayEnv): string {
  return JSON.stringify([
    env.TOKIMEKI_JWT_JWKS_URL,
    env.TOKIMEKI_JWT_ISSUER,
    env.TOKIMEKI_JWT_AUDIENCE,
    env.TOKIMEKI_JWT_JWKS_TTL_SECONDS,
    env.TOKIMEKI_JWT_CLOCK_SKEW_SECONDS,
  ]);
}

/** `readJwtAuthConfig` with a per-isolate cache keyed by the raw env values. */
export function readJwtAuthConfigCached(env: RelayEnv): JwtConfigStatus {
  const key = jwtConfigCacheKey(env);
  if (cachedJwtConfig !== null && cachedJwtConfigKey === key) {
    return cachedJwtConfig;
  }
  cachedJwtConfig = readJwtAuthConfig(env);
  cachedJwtConfigKey = key;
  return cachedJwtConfig;
}

// ---------------------------------------------------------------------------
// Value shape check
// ---------------------------------------------------------------------------

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** Translate a base64url string to the standard base64 alphabet for `atob`. */
function base64UrlToBase64(segment: string): string {
  let normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  if (normalized.length % 4 !== 0) {
    normalized += "=".repeat(4 - (normalized.length % 4));
  }
  return normalized;
}

/**
 * Strict base64url decode: charset is validated before `atob`, padding is
 * restored, and the bytes are decoded as UTF-8 with `fatal: true`.
 * Returns `null` for any malformed input.
 */
function decodeBase64UrlUtf8(segment: string): string | null {
  if (segment.length === 0 || !BASE64URL_SEGMENT.test(segment)) {
    return null;
  }
  let binary: string;
  try {
    binary = atob(base64UrlToBase64(segment));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> | null {
  const text = decodeBase64UrlUtf8(segment);
  if (text === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function decodeBase64UrlBytes(segment: string): Uint8Array | null {
  if (segment.length === 0 || !BASE64URL_SEGMENT.test(segment)) {
    return null;
  }
  try {
    const binary = atob(base64UrlToBase64(segment));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Cheap, network-free JWT shape check used before mode dispatch.
 *
 * Accepts only: exactly three non-empty dot-separated base64url segments, a
 * total length of at most 8192 chars, and a JSON header with `alg="ES256"`
 * plus a non-empty `kid` (at most 128 chars). The segment-shape part of this
 * predicate is reused by the Session JWT work (task A), so it deliberately
 * checks the header alg/kid instead of counting dots alone.
 */
export function looksLikeJwt(token: string): boolean {
  if (token.length === 0 || token.length > MAX_JWT_LENGTH) {
    return false;
  }
  const segments = token.split(".");
  if (segments.length !== 3) {
    return false;
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  if (
    headerSegment === undefined ||
    payloadSegment === undefined ||
    signatureSegment === undefined ||
    headerSegment.length === 0 ||
    payloadSegment.length === 0 ||
    signatureSegment.length === 0
  ) {
    return false;
  }
  if (
    !BASE64URL_SEGMENT.test(headerSegment) ||
    !BASE64URL_SEGMENT.test(payloadSegment) ||
    !BASE64URL_SEGMENT.test(signatureSegment)
  ) {
    return false;
  }
  const header = decodeBase64UrlJson(headerSegment);
  if (header === null) {
    return false;
  }
  if (header.alg !== "ES256") {
    return false;
  }
  const kid = header.kid;
  return typeof kid === "string" && kid.length > 0 && kid.length <= MAX_KID_LENGTH;
}

// ---------------------------------------------------------------------------
// JWKS cache
// ---------------------------------------------------------------------------

interface CachedJwks {
  readonly url: string;
  readonly keys: ReadonlyMap<string, CryptoKey>;
  readonly expiresAt: number; // Date.now() ms
  readonly lastFetchAt: number; // Date.now() ms
}

const jwksCache = new Map<string, CachedJwks>();
const jwksInFlight = new Map<string, Promise<CachedJwks>>();
/** Last fetch attempt (success or failure) per URL, driving the 30 s gates. */
const jwksLastAttempt = new Map<string, number>();

export interface JwksLookup {
  /** The key for `kid` was found (fresh or cached). */
  readonly kind: "key";
  readonly key: CryptoKey;
}

export type JwksFailure =
  | { readonly kind: "unavailable" }
  | { readonly kind: "unknown_kid" };

class JwksFetchError extends Error {}

async function fetchAndCacheJwks(
  config: JwtAuthConfig,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<CachedJwks> {
  jwksLastAttempt.set(config.jwksUrl, nowMs);
  let response: Response;
  try {
    response = await fetchImpl(config.jwksUrl, {
      method: "GET",
      // The Workers runtime only supports "follow"/"manual"; "manual" never
      // follows a bounce, so a redirected JWKS surfaces as a non-ok response
      // and fails closed.
      redirect: "manual",
      signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new JwksFetchError();
  }
  if (!response.ok) {
    throw new JwksFetchError();
  }
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_JWKS_BYTES) {
    throw new JwksFetchError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    throw new JwksFetchError();
  }
  const keys = await parseJwksKeys(parsed);
  if (keys === null) {
    throw new JwksFetchError();
  }
  const entry: CachedJwks = {
    url: config.jwksUrl,
    keys,
    expiresAt: nowMs + config.jwksTtlSeconds * 1000,
    lastFetchAt: nowMs,
  };
  jwksCache.set(config.jwksUrl, entry);
  while (jwksCache.size > MAX_JWKS_CACHE_URLS) {
    const oldest = jwksCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    jwksCache.delete(oldest);
  }
  return entry;
}

/**
 * Parse and import a JWKS document. The whole document is rejected when any
 * key is malformed or a `kid` is duplicated (fail closed instead of picking
 * an arbitrary key). WebCrypto `importKey` is asynchronous, so the parse is
 * too.
 */
async function parseJwksKeys(parsed: unknown): Promise<ReadonlyMap<string, CryptoKey> | null> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const rawKeys = (parsed as { keys?: unknown }).keys;
  if (!Array.isArray(rawKeys) || rawKeys.length === 0 || rawKeys.length > MAX_JWKS_KEYS) {
    return null;
  }
  const keys = new Map<string, CryptoKey>();
  for (const raw of rawKeys) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return null;
    }
    const jwk = raw as Record<string, unknown>;
    if (jwk.kty !== "EC" || jwk.crv !== "P-256") {
      return null;
    }
    if (jwk.alg !== undefined && jwk.alg !== "ES256") {
      return null;
    }
    if (jwk.use !== undefined && jwk.use !== "sig") {
      return null;
    }
    const kid = jwk.kid;
    if (typeof kid !== "string" || kid.length === 0 || kid.length > MAX_KID_LENGTH) {
      return null;
    }
    if (keys.has(kid)) {
      return null;
    }
    if (
      typeof jwk.x !== "string" ||
      jwk.x.length === 0 ||
      typeof jwk.y !== "string" ||
      jwk.y.length === 0
    ) {
      return null;
    }
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
    } catch {
      return null;
    }
    keys.set(kid, key);
  }
  return keys;
}

/** Run one deduplicated fetch attempt; returns null on failure. */
async function attemptJwksFetch(
  config: JwtAuthConfig,
  fetchImpl: typeof fetch,
  nowMs: number,
): Promise<CachedJwks | null> {
  const inFlight = jwksInFlight.get(config.jwksUrl);
  if (inFlight !== undefined) {
    try {
      return await inFlight;
    } catch {
      return null;
    }
  }
  const promise = fetchAndCacheJwks(config, fetchImpl, nowMs);
  jwksInFlight.set(config.jwksUrl, promise);
  try {
    return await promise;
  } catch {
    return null;
  } finally {
    jwksInFlight.delete(config.jwksUrl);
  }
}

/**
 * Resolve the verification key for `kid`.
 *
 * - A valid unexpired cache wins without network traffic.
 * - Without a usable cache (missing or expired), one fetch is attempted,
 *   gated to once per 30 s per URL (failures stamp the gate too, so a down
 *   JWKS is not retried per connection).
 * - A fresh cache without the requested `kid` triggers one forced refresh,
 *   also gated to once per 30 s.
 * - Outcomes: the key, `unknown_kid` (a cache exists but lacks the kid), or
 *   `unavailable` (no usable cache and the fetch failed or was gated off).
 */
export async function getJwksKey(
  config: JwtAuthConfig,
  kid: string,
  options: { nowMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<JwksLookup | JwksFailure> {
  const nowMs = options.nowMs ?? Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const cached = jwksCache.get(config.jwksUrl);
  const lastAttempt = jwksLastAttempt.get(config.jwksUrl) ?? 0;
  const gateOpen = nowMs - lastAttempt >= JWKS_REFRESH_MIN_INTERVAL_MS;

  if (cached !== undefined && nowMs < cached.expiresAt) {
    const key = cached.keys.get(kid);
    if (key !== undefined) {
      return { kind: "key", key };
    }
    // Unknown kid on a fresh cache: one forced refresh, gated by 30 s.
    if (gateOpen) {
      const refreshed = await attemptJwksFetch(config, fetchImpl, nowMs);
      if (refreshed !== null) {
        const refreshedKey = refreshed.keys.get(kid);
        return refreshedKey !== undefined
          ? { kind: "key", key: refreshedKey }
          : { kind: "unknown_kid" };
      }
    }
    return { kind: "unknown_kid" };
  }

  // No cache or expired cache: attempt a fetch when the gate allows it.
  if (gateOpen) {
    const refreshed = await attemptJwksFetch(config, fetchImpl, nowMs);
    if (refreshed !== null) {
      const key = refreshed.keys.get(kid);
      return key !== undefined ? { kind: "key", key } : { kind: "unknown_kid" };
    }
  }
  // Fetch failed or was gated off: fall back to a stale cache if it helps.
  if (cached !== undefined) {
    const key = cached.keys.get(kid);
    return key !== undefined ? { kind: "key", key } : { kind: "unknown_kid" };
  }
  return { kind: "unavailable" };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type JwtFailureReason =
  | "malformed_token"
  | "unsupported_alg"
  | "unknown_kid"
  | "signature_invalid"
  | "claims_invalid"
  | "expired"
  | "jwks_unavailable";

export interface HostJwtClaims {
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly sub: string;
  readonly namespace: string;
  readonly tokenUse: "host";
  readonly scopes: readonly string[];
  readonly issuedAt: number;
  readonly notBefore: number | null;
  readonly expiresAt: number;
  readonly jti: string | null;
}

export type JwtVerification =
  | { readonly ok: true; readonly claims: HostJwtClaims }
  | { readonly ok: false; readonly reason: JwtFailureReason };

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function validateClaims(
  payload: Record<string, unknown>,
  config: JwtAuthConfig,
  nowSeconds: number,
): { ok: true; claims: HostJwtClaims } | { ok: false; reason: JwtFailureReason } {
  const iss = payload.iss;
  if (typeof iss !== "string" || iss !== config.issuer) {
    return { ok: false, reason: "claims_invalid" };
  }
  const aud = payload.aud;
  const audMatches =
    typeof aud === "string"
      ? aud === config.audience
      : Array.isArray(aud) &&
        aud.length > 0 &&
        aud.every((entry) => typeof entry === "string") &&
        (aud as readonly string[]).includes(config.audience);
  if (!audMatches) {
    return { ok: false, reason: "claims_invalid" };
  }
  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0 || sub.length > 128) {
    return { ok: false, reason: "claims_invalid" };
  }
  const namespace = payload.namespace;
  if (typeof namespace !== "string" || !NAMESPACE_PATTERN.test(namespace)) {
    return { ok: false, reason: "claims_invalid" };
  }
  if (payload.token_use !== "host") {
    return { ok: false, reason: "claims_invalid" };
  }
  const scope = payload.scope;
  if (typeof scope !== "string") {
    return { ok: false, reason: "claims_invalid" };
  }
  const scopes = scope.split(/\s+/).filter((entry) => entry.length > 0);
  if (!scopes.includes("host")) {
    return { ok: false, reason: "claims_invalid" };
  }
  const iat = payload.iat;
  if (!isSafeInteger(iat) || iat > nowSeconds + config.clockSkewSeconds) {
    return { ok: false, reason: "claims_invalid" };
  }
  const nbfRaw = payload.nbf;
  let notBefore: number | null = null;
  if (nbfRaw !== undefined) {
    if (!isSafeInteger(nbfRaw)) {
      return { ok: false, reason: "claims_invalid" };
    }
    notBefore = nbfRaw;
    if (nowSeconds + config.clockSkewSeconds < notBefore) {
      return { ok: false, reason: "claims_invalid" };
    }
  }
  const exp = payload.exp;
  if (!isSafeInteger(exp)) {
    return { ok: false, reason: "claims_invalid" };
  }
  if (exp <= iat) {
    return { ok: false, reason: "claims_invalid" };
  }
  if (nowSeconds >= exp + config.clockSkewSeconds) {
    return { ok: false, reason: "expired" };
  }
  const jtiRaw = payload.jti;
  let jti: string | null = null;
  if (jtiRaw !== undefined) {
    if (typeof jtiRaw !== "string" || jtiRaw.length > 128) {
      return { ok: false, reason: "claims_invalid" };
    }
    jti = jtiRaw;
  }
  return {
    ok: true,
    claims: {
      iss,
      aud: typeof aud === "string" ? aud : Object.freeze([...(aud as readonly string[])]),
      sub,
      namespace,
      tokenUse: "host",
      scopes: Object.freeze(scopes),
      issuedAt: iat,
      notBefore,
      expiresAt: exp,
      jti,
    },
  };
}

/**
 * Verify a Host JWT: strict decode, ES256 signature first, then the full
 * claims matrix. Signature verification happens before any claim is trusted.
 */
export async function verifyHostJwt(
  token: string,
  config: JwtAuthConfig,
  options: { nowSeconds?: number; nowMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<JwtVerification> {
  const nowMs = options.nowMs ?? Date.now();
  const nowSeconds = options.nowSeconds ?? Math.floor(nowMs / 1000);
  if (token.length === 0 || token.length > MAX_JWT_LENGTH) {
    return { ok: false, reason: "malformed_token" };
  }
  const segments = token.split(".");
  if (segments.length !== 3) {
    return { ok: false, reason: "malformed_token" };
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  if (
    headerSegment === undefined ||
    payloadSegment === undefined ||
    signatureSegment === undefined
  ) {
    return { ok: false, reason: "malformed_token" };
  }
  const header = decodeBase64UrlJson(headerSegment);
  if (header === null) {
    return { ok: false, reason: "malformed_token" };
  }
  if (header.alg !== "ES256") {
    return { ok: false, reason: "unsupported_alg" };
  }
  const kid = header.kid;
  if (typeof kid !== "string" || kid.length === 0 || kid.length > MAX_KID_LENGTH) {
    return { ok: false, reason: "malformed_token" };
  }
  const payload = decodeBase64UrlJson(payloadSegment);
  if (payload === null) {
    return { ok: false, reason: "malformed_token" };
  }
  const signature = decodeBase64UrlBytes(signatureSegment);
  if (signature === null) {
    return { ok: false, reason: "malformed_token" };
  }

  const lookup = await getJwksKey(config, kid, { nowMs, fetchImpl: options.fetchImpl });
  if (lookup.kind === "unavailable") {
    return { ok: false, reason: "jwks_unavailable" };
  }
  if (lookup.kind === "unknown_kid") {
    return { ok: false, reason: "unknown_kid" };
  }

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      lookup.key,
      signature,
      new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
    );
  } catch {
    return { ok: false, reason: "signature_invalid" };
  }
  if (!valid) {
    return { ok: false, reason: "signature_invalid" };
  }

  return validateClaims(payload, config, nowSeconds);
}

/** Test hook: clear the JWKS cache and the per-isolate config cache. */
export function __resetJwtCacheForTests(): void {
  jwksCache.clear();
  jwksInFlight.clear();
  jwksLastAttempt.clear();
  cachedJwtConfig = null;
  cachedJwtConfigKey = null;
}

// ---------------------------------------------------------------------------
// Host credential carrier selection
// ---------------------------------------------------------------------------

export type HostCredentialSelection =
  | { readonly action: "none" }
  | {
      readonly action: "credential";
      readonly value: string;
      readonly carrier: "token" | "authorization";
    }
  | { readonly action: "unauthorized"; readonly reason: string };

const AUTHORIZATION_BEARER = /^Bearer[ \t]+([^\s,]+)[ \t]*$/i;

/**
 * Decide which value (if any) is the host credential, and on which carrier.
 *
 * Rules (JWT mode not `disabled`; `disabled` ignores Authorization entirely):
 * - exactly one `Bearer <token>` is accepted (scheme case-insensitive,
 *   single value, no whitespace in the token); other schemes are ignored;
 * - the Bearer is only a credential when the token header is absent or empty;
 * - equal token-header and Bearer values collapse into one credential from
 *   the token header; different values are ambiguous (401);
 * - a malformed Bearer 401s a request that has no usable token header
 *   (never a silent downgrade) and is ignored when a non-empty token header
 *   is present;
 * - a present-but-empty token header without a usable Bearer is 401 (an
 *   empty header is not a viewer downgrade).
 */
export function selectHostCredential(
  mode: JwtConfigStatus["status"],
  token: string | null,
  authorization: string | null,
): HostCredentialSelection {
  let bearerToken: string | null = null;
  let bearerMalformed = false;
  if (mode !== "disabled" && authorization !== null) {
    const trimmed = authorization.trim();
    if (trimmed.includes(",")) {
      // Multiple Authorization values are joined by the runtime; a JWT cannot
      // contain a comma, so this is always malformed.
      bearerMalformed = true;
    } else {
      const match = AUTHORIZATION_BEARER.exec(trimmed);
      if (match !== null) {
        const value = match[1];
        if (value !== undefined && value.length > 0) {
          bearerToken = value;
        } else {
          bearerMalformed = true;
        }
      } else if (/^Bearer/i.test(trimmed)) {
        // A Bearer scheme with a missing/whitespace-only token is malformed.
        bearerMalformed = true;
      }
      // Any other scheme is ignored entirely.
    }
  }

  if (token !== null && token.length > 0) {
    if (bearerToken !== null) {
      if (bearerToken === token) {
        return { action: "credential", value: token, carrier: "token" };
      }
      return { action: "unauthorized", reason: "ambiguous_credentials" };
    }
    return { action: "credential", value: token, carrier: "token" };
  }
  if (bearerToken !== null) {
    return { action: "credential", value: bearerToken, carrier: "authorization" };
  }
  if (bearerMalformed) {
    return { action: "unauthorized", reason: "malformed_bearer" };
  }
  if (token !== null) {
    // Present but empty token header, no usable Bearer.
    return { action: "unauthorized", reason: "empty_token_header" };
  }
  return { action: "none" };
}
