/**
 * Minimal TokiAPI onboarding client (public, cross-origin-safe).
 *
 * Only the three documented public endpoints are used:
 *   GET  <origin>/api/config
 *   POST <origin>/api/tokimeki/anon-host
 *   POST <origin>/api/tokimeki/attach/cli
 *
 * Requests never carry cookies/credentials, never follow redirects, time out,
 * and cap the response body. Error objects carry field-level messages only;
 * token/invite values are never echoed.
 */

import { isValidSessionId } from "@limccn/tokimeki-protocol";
import { HOST_NAMESPACE_PATTERN, isNamespaceScopedSession } from "../config.js";

export const DEFAULT_TOKIAPI_ORIGIN = "https://tokiapi.app";
export const DEFAULT_HOSTED_RELAY_URL = "wss://relay.tokiapi.app";
export const TOKIAPI_TIMEOUT_MS = 10_000;
export const TOKIAPI_MAX_BODY_BYTES = 64 * 1024;

export type TokiApiErrorKind =
  | "network"
  | "rate_limited"
  | "unavailable"
  | "invalid_invite"
  | "schema"
  | "server";

export class TokiApiError extends Error {
  override readonly name = "TokiApiError";
  readonly kind: TokiApiErrorKind;
  readonly retryAfterSeconds: number | null;
  readonly status: number | null;

  constructor(
    kind: TokiApiErrorKind,
    message: string,
    options: { retryAfterSeconds?: number | null; status?: number | null } = {},
  ) {
    super(message);
    this.kind = kind;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.status = options.status ?? null;
  }
}

export interface TokiApiDeps {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface PublicConfig {
  readonly tokimekiEnabled: boolean;
  readonly tokimekiRelayUrl: string | null;
}

export interface AnonymousHostGrant {
  readonly token: string;
  readonly namespace: string;
  readonly session: string;
  readonly inviteUrl: string | null;
  readonly expiresAt: number | null;
}

export interface AttachGrant {
  readonly token: string;
  readonly session: string;
  readonly mode: "viewer" | "listener";
  readonly allowWeb: boolean | null;
  readonly passcodeRequired: boolean;
  readonly expiresAt: number | null;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** Normalize a TokiAPI provider base URL; only https (or loopback http) is accepted. */
export function normalizeProviderOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TokiApiError("schema", "the TokiAPI origin is not a valid URL");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TokiApiError("schema", "the TokiAPI origin must not contain credentials");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new TokiApiError("schema", "the TokiAPI origin must not contain a query or fragment");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new TokiApiError("schema", "the TokiAPI origin must not contain a path");
  }
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))
  ) {
    throw new TokiApiError("schema", "the TokiAPI origin must use https (http is loopback-only)");
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Bind a provider-returned relay URL to the provider origin.
 *
 * The Session JWT is about to be sent to this relay, so an arbitrary URL from
 * the provider response would redirect the credential. https/wss only, no
 * userinfo/query/fragment, and the relay host must be the provider host or its
 * `relay.` sibling. `relay.tokiapi.app` is the one explicit cross-host pair.
 */
export function validateProviderRelayUrl(raw: string, providerOrigin: string): string {
  let relay: URL;
  let provider: URL;
  try {
    relay = new URL(raw);
    provider = new URL(providerOrigin);
  } catch {
    throw new TokiApiError("schema", "the provider relay URL is not a valid URL");
  }
  if (relay.username !== "" || relay.password !== "") {
    throw new TokiApiError("schema", "the provider relay URL must not contain credentials");
  }
  if (relay.search !== "" || relay.hash !== "") {
    throw new TokiApiError("schema", "the provider relay URL must not contain a query or fragment");
  }
  const loopbackPair = isLoopbackHostname(provider.hostname) && isLoopbackHostname(relay.hostname);
  if (relay.protocol !== "wss:" && !(relay.protocol === "ws:" && loopbackPair)) {
    throw new TokiApiError(
      "schema",
      "the provider relay URL must use wss:// (ws:// is loopback-only)",
    );
  }
  const providerHost = provider.hostname.toLowerCase();
  const relayHost = relay.hostname.toLowerCase();
  const sameHost = relayHost === providerHost;
  const sibling = relayHost === `relay.${providerHost}`;
  const tokiapiRelay = providerHost === "tokiapi.app" && relayHost === "relay.tokiapi.app";
  if (!(sameHost || sibling || tokiapiRelay)) {
    throw new TokiApiError(
      "schema",
      "the provider relay URL is not bound to the provider origin; refusing to send a Session JWT there",
    );
  }
  const pathname = relay.pathname.replace(/\/+$/, "");
  return `${relay.protocol}//${relay.host}${pathname}`;
}

async function readBodyCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > TOKIAPI_MAX_BODY_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // best effort
      }
      throw new TokiApiError("schema", "the TokiAPI response is too large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function parseRetryAfter(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (header === null) return null;
  const seconds = Number.parseInt(header.trim(), 10);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

async function requestJson(
  url: string,
  init: RequestInit,
  deps: TokiApiDeps,
): Promise<{ status: number; body: Record<string, unknown> | null; retryAfter: number | null }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(deps.timeoutMs ?? TOKIAPI_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    throw new TokiApiError("network", `TokiAPI request failed: ${message}`);
  }
  const retryAfter = parseRetryAfter(response);
  let text = "";
  try {
    text = await readBodyCapped(response);
  } catch (error) {
    if (error instanceof TokiApiError) throw error;
    throw new TokiApiError("network", "unable to read the TokiAPI response");
  }
  let body: Record<string, unknown> | null = null;
  if (text.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = null;
    }
  }
  return { status: response.status, body, retryAfter };
}

function providerMessage(body: Record<string, unknown> | null): string | null {
  const error = body?.error;
  if (typeof error === "string" && error.length > 0 && error.length <= 300) return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.length > 0 && message.length <= 300) return message;
  }
  const message = body?.message;
  return typeof message === "string" && message.length > 0 && message.length <= 300
    ? message
    : null;
}

function mapHttpError(
  status: number,
  body: Record<string, unknown> | null,
  retryAfter: number | null,
  action: string,
): TokiApiError {
  const detail = providerMessage(body);
  if (status === 410) {
    return new TokiApiError(
      "invalid_invite",
      detail ?? `${action}: the invite is invalid or expired`,
      {
        status,
      },
    );
  }
  if (status === 429) {
    return new TokiApiError("rate_limited", detail ?? `${action}: rate limited`, {
      status,
      retryAfterSeconds: retryAfter,
    });
  }
  if (status === 503) {
    return new TokiApiError("unavailable", detail ?? `${action}: the service is not configured`, {
      status,
    });
  }
  if (status >= 500) {
    return new TokiApiError("server", detail ?? `${action}: server error (HTTP ${status})`, {
      status,
    });
  }
  return new TokiApiError("schema", detail ?? `${action}: unexpected HTTP ${status}`, { status });
}

function requireString(record: Record<string, unknown>, name: string, max = 8192): string {
  const value = record[name];
  if (typeof value !== "string" || value.length === 0 || value.length > max || /\s/.test(value)) {
    throw new TokiApiError("schema", `TokiAPI response field ${name} is invalid`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, name: string, max = 8192): string | null {
  const value = record[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max) {
    throw new TokiApiError("schema", `TokiAPI response field ${name} is invalid`);
  }
  return value;
}

function optionalEpoch(record: Record<string, unknown>, name: string): number | null {
  const value = record[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TokiApiError("schema", `TokiAPI response field ${name} is invalid`);
  }
  return value;
}

function optionalBoolean(record: Record<string, unknown>, name: string): boolean | null {
  const value = record[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") {
    throw new TokiApiError("schema", `TokiAPI response field ${name} is invalid`);
  }
  return value;
}

export async function getPublicConfig(
  providerOrigin: string,
  deps: TokiApiDeps = {},
): Promise<PublicConfig> {
  const origin = normalizeProviderOrigin(providerOrigin);
  const result = await requestJson(`${origin}/api/config`, { method: "GET" }, deps);
  if (result.status !== 200 || result.body === null) {
    throw mapHttpError(result.status, result.body, result.retryAfter, "TokiAPI config");
  }
  const enabled = result.body.tokimekiEnabled;
  const relay = result.body.tokimekiRelayUrl;
  if (typeof enabled !== "boolean") {
    throw new TokiApiError("schema", "TokiAPI config is missing tokimekiEnabled");
  }
  if (relay !== undefined && typeof relay !== "string") {
    throw new TokiApiError("schema", "TokiAPI config field tokimekiRelayUrl is invalid");
  }
  return {
    tokimekiEnabled: enabled,
    tokimekiRelayUrl: typeof relay === "string" && relay.length > 0 ? relay : null,
  };
}

export async function requestAnonymousHost(
  providerOrigin: string,
  deps: TokiApiDeps = {},
): Promise<AnonymousHostGrant> {
  const origin = normalizeProviderOrigin(providerOrigin);
  const result = await requestJson(
    `${origin}/api/tokimeki/anon-host`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    deps,
  );
  if (result.status !== 200 || result.body === null) {
    throw mapHttpError(result.status, result.body, result.retryAfter, "anonymous host request");
  }
  const token = requireString(result.body, "token");
  const namespace = requireString(result.body, "namespace", 64);
  const session = requireString(result.body, "session", 128);
  if (!HOST_NAMESPACE_PATTERN.test(namespace)) {
    throw new TokiApiError("schema", "TokiAPI response namespace is invalid");
  }
  if (!isValidSessionId(session) || !isNamespaceScopedSession(session, namespace)) {
    throw new TokiApiError("schema", "TokiAPI response session is invalid");
  }
  const inviteUrl = optionalString(result.body, "inviteUrl", 2048);
  if (inviteUrl !== null && !/^https:\/\//i.test(inviteUrl)) {
    throw new TokiApiError("schema", "TokiAPI response inviteUrl must be https");
  }
  return {
    token,
    namespace,
    session,
    inviteUrl,
    expiresAt: optionalEpoch(result.body, "expiresAt"),
  };
}

export async function exchangeAttachCode(
  providerOrigin: string,
  code: string,
  deps: TokiApiDeps = {},
): Promise<AttachGrant> {
  if (code.length === 0 || code.length > 64 || /[\s\p{Cc}]/u.test(code)) {
    throw new TokiApiError("schema", "the invite code is invalid");
  }
  const origin = normalizeProviderOrigin(providerOrigin);
  const result = await requestJson(
    `${origin}/api/tokimeki/attach/cli`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    },
    deps,
  );
  if (result.status !== 200 || result.body === null) {
    throw mapHttpError(result.status, result.body, result.retryAfter, "invite exchange");
  }
  const token = requireString(result.body, "token");
  const session = requireString(result.body, "session", 128);
  if (!isValidSessionId(session)) {
    throw new TokiApiError("schema", "TokiAPI response session is invalid");
  }
  const mode = result.body.mode;
  if (mode !== "viewer" && mode !== "listener") {
    throw new TokiApiError("schema", "TokiAPI response mode must be viewer or listener");
  }
  return {
    token,
    session,
    mode,
    allowWeb: optionalBoolean(result.body, "allowWeb"),
    passcodeRequired: optionalBoolean(result.body, "passcodeRequired") === true,
    expiresAt: optionalEpoch(result.body, "expiresAt"),
  };
}
