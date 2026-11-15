import {
  type IceProvider,
  type IceServerConfig,
  IceServerConfigSchema,
} from "@limccn/tokimeki-protocol";

import { hmacSha1Base64 } from "./crypto-utils.js";
import {
  type CoturnUrlConfig,
  coturnUrlList,
  DEFAULT_STUN_URLS,
  parsePositiveInt,
  stunUrlList,
} from "./env.js";
import { readTurnCache, writeTurnCache } from "./storage.js";

/** TURN configuration subset needed by provider selection and issuance. */
export interface TurnEnv {
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
}

export type TurnMode = "auto" | "coturn" | "cloudflare" | "none";

export interface IssuedIceConfig {
  readonly iceServers: IceServerConfig[];
  readonly iceProvider: IceProvider;
  readonly iceExpiresAt: number | null;
  /** Set when a configured TURN provider failed and STUN-only was returned. */
  readonly fallbackReason?: "turn_issue_failed";
}

export interface IssueIceConfigOptions {
  readonly env: TurnEnv;
  readonly clientId: string;
  /** Required only for the Cloudflare TURN credential cache. */
  readonly sql?: SqlStorage;
  /** Explicit `ice-refresh` provider request; ignored when unconfigured. */
  readonly requestedProvider?: IceProvider;
  readonly now?: number;
}

const DEFAULT_TURN_TTL_SECONDS = 86_400;
const MAX_CLOUDFLARE_TURN_TTL_SECONDS = 172_800;
const CLOUDFLARE_CACHE_REFRESH_WINDOW_MS = 5 * 60 * 1000;
/** ICE is negotiated during `hello`; a stalled TURN API must not hold it up. */
const CLOUDFLARE_TURN_TIMEOUT_MS = 5_000;
const CLOUDFLARE_TURN_URL =
  "https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate-ice-servers";

function splitUrls(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function hasCoturnRestConfig(env: TurnEnv): boolean {
  return coturnUrlList(env).length > 0 && Boolean(env.TOKIMEKI_COTURN_SECRET);
}

function hasStaticTurnConfig(env: TurnEnv): boolean {
  return (
    splitUrls(env.TOKIMEKI_TURN_URLS).length > 0 &&
    Boolean(env.TOKIMEKI_TURN_USERNAME) &&
    Boolean(env.TOKIMEKI_TURN_CREDENTIAL)
  );
}

function hasCloudflareTurnConfig(env: TurnEnv): boolean {
  return Boolean(env.TOKIMEKI_TURN_KEY_ID) && Boolean(env.TOKIMEKI_TURN_API_TOKEN);
}

/** Parse `TOKIMEKI_TURN_PROVIDER`, treating unknown values as `auto`. */
export function parseTurnMode(env: TurnEnv): TurnMode {
  switch ((env.TOKIMEKI_TURN_PROVIDER ?? "auto").trim().toLowerCase()) {
    case "coturn":
      return "coturn";
    case "cloudflare":
      return "cloudflare";
    case "none":
      return "none";
    default:
      return "auto";
  }
}

function defaultProvider(mode: TurnMode, env: TurnEnv): IceProvider {
  switch (mode) {
    case "coturn":
      // Explicit coturn never silently falls through to Cloudflare.
      if (hasCoturnRestConfig(env)) {
        return "coturn";
      }
      return hasStaticTurnConfig(env) ? "static" : "stun";
    case "cloudflare":
      // Explicit Cloudflare only uses Cloudflare TURN (plus STUN).
      return hasCloudflareTurnConfig(env) ? "cloudflare" : "stun";
    case "none":
      return "stun";
    default:
      if (hasCoturnRestConfig(env)) {
        return "coturn";
      }
      if (hasStaticTurnConfig(env)) {
        return "static";
      }
      return hasCloudflareTurnConfig(env) ? "cloudflare" : "stun";
  }
}

function requestedProvider(requested: IceProvider | undefined, env: TurnEnv): IceProvider | null {
  if (requested === undefined) {
    return null;
  }
  switch (requested) {
    case "stun":
      return "stun";
    case "coturn":
      if (hasCoturnRestConfig(env)) {
        return "coturn";
      }
      return hasStaticTurnConfig(env) ? "static" : null;
    case "static":
      return hasStaticTurnConfig(env) ? "static" : null;
    case "cloudflare":
      return hasCloudflareTurnConfig(env) ? "cloudflare" : null;
    default:
      return null;
  }
}

/**
 * Effective ICE provider for a connection.
 *
 * An `ice-refresh` provider override is honored only when the provider is
 * configured and allowed by `TOKIMEKI_TURN_PROVIDER`; otherwise the mode
 * default is used. This keeps `none`/`coturn`/`cloudflare` operator policy
 * authoritative over client requests.
 */
export function resolveIceProvider(env: TurnEnv, requested?: IceProvider): IceProvider {
  const mode = parseTurnMode(env);
  const override = requestedProvider(requested, env);
  if (override !== null && isProviderAllowedByMode(mode, override)) {
    return override;
  }
  return defaultProvider(mode, env);
}

function isProviderAllowedByMode(mode: TurnMode, provider: IceProvider): boolean {
  switch (mode) {
    case "none":
      return provider === "stun";
    case "coturn":
      return provider === "stun" || provider === "coturn" || provider === "static";
    case "cloudflare":
      return provider === "stun" || provider === "cloudflare";
    case "auto":
      return true;
  }
}

/** Health-check summary: effective provider name and whether TURN is configured. */
export function describeTurn(env: TurnEnv): {
  readonly provider: IceProvider;
  readonly configured: boolean;
} {
  const provider = defaultProvider(parseTurnMode(env), env);
  return { provider, configured: provider !== "stun" };
}

function stunServers(env: TurnEnv): IceServerConfig[] {
  return stunUrlList(env).map((urls) => ({ urls }));
}

/** STUN-only fallback used when no TURN provider is configured or issuance fails. */
export function stunOnlyIceConfig(env: TurnEnv): IssuedIceConfig {
  return { iceServers: stunServers(env), iceProvider: "stun", iceExpiresAt: null };
}

function withStun(env: TurnEnv, servers: IceServerConfig[]): IceServerConfig[] {
  return [...stunServers(env), ...servers];
}

export interface CoturnRestCredential {
  readonly username: string;
  readonly credential: string;
  readonly expiresAt: number;
}

/**
 * Generate coturn TURN REST credentials.
 *
 * coturn expects `username = "<expiry-unix>:<name>"` and
 * `credential = base64(HMAC-SHA1(static-auth-secret, username))`.
 */
export async function createCoturnRestCredential(
  secret: string,
  clientId: string,
  ttlSeconds: number,
  now: number,
): Promise<CoturnRestCredential> {
  const expiresAt = now + ttlSeconds * 1000;
  const expiryUnix = Math.floor(expiresAt / 1000);
  const username = `${expiryUnix}:${clientId}`;
  const credential = await hmacSha1Base64(secret, username);
  return { username, credential, expiresAt };
}

async function issueCoturnRest(
  env: TurnEnv,
  clientId: string,
  now: number,
): Promise<IssuedIceConfig> {
  const urls = coturnUrlList(env);
  const secret = env.TOKIMEKI_COTURN_SECRET;
  if (urls.length === 0 || secret === undefined || secret.length === 0) {
    throw new Error("coturn REST is not configured");
  }
  const ttl = parsePositiveInt(env.TOKIMEKI_COTURN_TTL_SECONDS, DEFAULT_TURN_TTL_SECONDS);
  const { username, credential, expiresAt } = await createCoturnRestCredential(
    secret,
    clientId,
    ttl,
    now,
  );
  return {
    iceServers: withStun(
      env,
      urls.map((urlsEntry) => ({ urls: urlsEntry, username, credential })),
    ),
    iceProvider: "coturn",
    iceExpiresAt: expiresAt,
  };
}

function issueStatic(env: TurnEnv): IssuedIceConfig {
  const urls = splitUrls(env.TOKIMEKI_TURN_URLS);
  const username = env.TOKIMEKI_TURN_USERNAME;
  const credential = env.TOKIMEKI_TURN_CREDENTIAL;
  if (urls.length === 0 || username === undefined || credential === undefined) {
    throw new Error("static TURN is not configured");
  }
  return {
    iceServers: withStun(
      env,
      urls.map((urlsEntry) => ({ urls: urlsEntry, username, credential })),
    ),
    iceProvider: "static",
    iceExpiresAt: null,
  };
}

interface CloudflareCachePayload {
  readonly iceServers: IceServerConfig[];
}

function parseCloudflareIceServers(value: unknown): IceServerConfig[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const raw = (value as { iceServers?: unknown }).iceServers;
  const candidates = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const servers: IceServerConfig[] = [];
  for (const candidate of candidates) {
    const parsed = IceServerConfigSchema.safeParse(candidate);
    if (parsed.success) {
      servers.push(parsed.data);
    }
  }
  return servers;
}

function parseCloudflareCache(payloadJson: string): CloudflareCachePayload | null {
  try {
    const decoded = JSON.parse(payloadJson) as unknown;
    const servers = parseCloudflareIceServers(decoded);
    return servers.length > 0 ? { iceServers: servers } : null;
  } catch {
    return null;
  }
}

async function issueCloudflare(
  env: TurnEnv,
  sql: SqlStorage | undefined,
  now: number,
): Promise<IssuedIceConfig> {
  const keyId = env.TOKIMEKI_TURN_KEY_ID;
  const apiToken = env.TOKIMEKI_TURN_API_TOKEN;
  if (
    keyId === undefined ||
    keyId.length === 0 ||
    apiToken === undefined ||
    apiToken.length === 0
  ) {
    throw new Error("Cloudflare TURN is not configured");
  }
  const ttl = Math.min(
    parsePositiveInt(env.TOKIMEKI_TURN_TTL_SECONDS, DEFAULT_TURN_TTL_SECONDS),
    MAX_CLOUDFLARE_TURN_TTL_SECONDS,
  );

  if (sql !== undefined) {
    const cached = readTurnCache(sql, "cloudflare", now + CLOUDFLARE_CACHE_REFRESH_WINDOW_MS);
    if (cached !== null) {
      const payload = parseCloudflareCache(cached.payloadJson);
      if (payload !== null) {
        return {
          iceServers: withStun(env, payload.iceServers),
          iceProvider: "cloudflare",
          iceExpiresAt: cached.expiresAt,
        };
      }
    }
  }

  const endpoint = CLOUDFLARE_TURN_URL.replace("{keyId}", encodeURIComponent(keyId));
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ttl }),
    signal: AbortSignal.timeout(CLOUDFLARE_TURN_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error("Cloudflare TURN credential request failed");
  }
  const payload = parseCloudflareIceServers(await response.json());
  if (payload.length === 0) {
    throw new Error("Cloudflare TURN returned no ICE servers");
  }
  const iceExpiresAt = now + ttl * 1000;
  if (sql !== undefined) {
    writeTurnCache(sql, {
      payloadJson: JSON.stringify({ iceServers: payload }),
      expiresAt: iceExpiresAt,
    });
  }
  return {
    iceServers: withStun(env, payload),
    iceProvider: "cloudflare",
    iceExpiresAt,
  };
}

/**
 * Issue ICE servers for one authenticated client.
 *
 * Selection order for `auto`: coturn REST -> static TURN -> Cloudflare TURN ->
 * STUN-only. Failure to mint a configured provider falls back to STUN-only; the
 * Worker relay remains the final data path.
 */
export async function issueIceConfig(options: IssueIceConfigOptions): Promise<IssuedIceConfig> {
  const now = options.now ?? Date.now();
  const provider = resolveIceProvider(options.env, options.requestedProvider);
  try {
    switch (provider) {
      case "coturn":
        return await issueCoturnRest(options.env, options.clientId, now);
      case "static":
        return issueStatic(options.env);
      case "cloudflare":
        return await issueCloudflare(options.env, options.sql, now);
      default:
        return stunOnlyIceConfig(options.env);
    }
  } catch {
    // Keep the token/credential out of the error path; the caller logs only
    // the fact that a configured provider fell back to STUN.
    return { ...stunOnlyIceConfig(options.env), fallbackReason: "turn_issue_failed" };
  }
}

/** Default STUN URL exposed for documentation and tests. */
export const DEFAULT_STUN_URL = DEFAULT_STUN_URLS;
