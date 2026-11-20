import { isValidSessionId, PROTOCOL_VERSION } from "@limccn/tokimeki-protocol";

import { isMasterTokenValid } from "./auth.js";
import type { RelayEnv } from "./env.js";
import {
  type HostCredentialSelection,
  type HostJwtClaims,
  looksLikeJwt,
  readJwtAuthConfigCached,
  selectHostCredential,
  verifyHostJwt,
} from "./jwt-auth.js";
import { createLogger, type Logger } from "./logging.js";
import {
  isNamespaceSessionId,
  matchNamespaceToken,
  type NamespaceTokenConfig,
  parseNamespaceTokens,
} from "./namespace-tokens.js";
import { describeTurn } from "./turn.js";

export { SessionDurableObject } from "./session-do.js";

const SERVICE_NAME = "tokimeki-relay";

/**
 * Parsed `TOKIMEKI_NAMESPACE_TOKENS`, cached by raw secret value.
 *
 * Workers isolates are long-lived and the secret only changes on deploy or
 * secret rotation; re-parsing a bounded JSON object on every connection would
 * be wasted work. The master token participates in the key because a namespace
 * token equal to the root master must stay rejected after a rotation.
 */
let cachedNamespaceRaw: string | undefined;
let cachedNamespaceMaster: string | undefined;
let cachedNamespaceConfig: NamespaceTokenConfig | null = null;

function namespaceTokenConfig(
  raw: string | undefined,
  masterToken: string | undefined,
): NamespaceTokenConfig {
  if (
    cachedNamespaceConfig !== null &&
    cachedNamespaceRaw === raw &&
    cachedNamespaceMaster === masterToken
  ) {
    return cachedNamespaceConfig;
  }
  cachedNamespaceConfig = parseNamespaceTokens(raw, masterToken);
  cachedNamespaceRaw = raw;
  cachedNamespaceMaster = masterToken;
  return cachedNamespaceConfig;
}

/** One-shot per-isolate migration warnings (never contain values). */
let warnedFallbackDisabled = false;
/** Parsed namespace map that already produced the look-like-JWT warning. */
let checkedNamespaceJwtShapeConfig: NamespaceTokenConfig | null = null;

function jsonResponse(status: number, body: unknown, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

/**
 * Public liveness probe. Operational details such as TURN configuration live
 * behind the authenticated `/auth/whoami` endpoint instead.
 */
function healthPayload(): Record<string, unknown> {
  return {
    ok: true,
    service: SERVICE_NAME,
    protocolVersion: PROTOCOL_VERSION,
  };
}

/** Successful host authentication, with what the caller needs per endpoint. */
type HostAuthSuccess =
  | {
      readonly authMode: "jwt";
      readonly hostNamespace: string;
      readonly claims: HostJwtClaims;
    }
  | { readonly authMode: "namespace"; readonly hostNamespace: string; readonly claims: null }
  // The single-owner fallback credential: hostNamespace "*" is the pre-JWT
  // root namespace and only exists while namespace tokens are inactive.
  | { readonly authMode: "master"; readonly hostNamespace: "*"; readonly claims: null };

type HostAuthOutcome =
  | { readonly outcome: "none" }
  | { readonly outcome: "host"; readonly auth: HostAuthSuccess }
  | { readonly outcome: "response"; readonly response: Response };

/**
 * Shared host-authentication path for `/ws/<session>` and `/auth/whoami`.
 *
 * Carrier arbitration (the `X-Tokimeki-Token` header plus, outside disabled
 * JWT mode, `Authorization: Bearer`) is delegated to the pure
 * `selectHostCredential` helper; dispatch by value shape follows the order
 * fallback token -> three-segment JWT -> static namespace token. A fallback
 * token that happens to look like a JWT is never sent to the JWKS, and a
 * Bearer is never compared against namespace tokens.
 */
async function resolveHostAuth(
  request: Request,
  env: RelayEnv,
  logger: Logger,
  sessionId: string | null,
  presentedSession: string | null,
): Promise<HostAuthOutcome> {
  const tokenHeader = request.headers.get("x-tokimeki-token");
  const authorization = request.headers.get("authorization");
  const jwtStatus = readJwtAuthConfigCached(env);
  const namespaceConfig = namespaceTokenConfig(
    env.TOKIMEKI_NAMESPACE_TOKENS,
    env.TOKIMEKI_MASTER_TOKEN,
  );
  const namespaceActive = namespaceConfig.error === undefined && namespaceConfig.entries.length > 0;
  const fallbackAllowed = !namespaceActive;

  if (namespaceActive && env.TOKIMEKI_MASTER_TOKEN !== undefined && !warnedFallbackDisabled) {
    warnedFallbackDisabled = true;
    logger.warn("fallback_token_disabled");
  }
  if (
    jwtStatus.status !== "disabled" &&
    namespaceConfig.error === undefined &&
    namespaceActive &&
    checkedNamespaceJwtShapeConfig !== namespaceConfig
  ) {
    // Checked once per parsed map, not on every connection: the shape test
    // decodes each token, and the warning is a migration diagnostic only.
    checkedNamespaceJwtShapeConfig = namespaceConfig;
    for (const entry of namespaceConfig.entries) {
      if (looksLikeJwt(entry.token)) {
        logger.warn("namespace_token_looks_like_jwt", { namespace: entry.namespace });
      }
    }
  }

  const selection: HostCredentialSelection = selectHostCredential(
    jwtStatus.status,
    tokenHeader,
    authorization,
  );
  if (selection.action === "none") {
    return { outcome: "none" };
  }
  if (selection.action === "unauthorized") {
    logger.warn("jwt_auth_failed", { sessionId, reason: selection.reason });
    return {
      outcome: "response",
      response: jsonResponse(401, { ok: false, error: "unauthorized" }),
    };
  }
  const credential = selection.value;

  // A session token must never double as the host credential: a viewer
  // already holds the session token and could otherwise claim the host role.
  if (presentedSession !== null && credential === presentedSession) {
    logger.warn("master_session_token_equal", { sessionId });
    return {
      outcome: "response",
      response: jsonResponse(401, { ok: false, error: "unauthorized" }),
    };
  }

  // 1. Fallback token (constant-time compare, token carrier only). First so a
  //    fallback secret that looks like a JWT is never sent to the JWKS.
  if (selection.carrier === "token" && fallbackAllowed) {
    if (await isMasterTokenValid(credential, env.TOKIMEKI_MASTER_TOKEN)) {
      return {
        outcome: "host",
        auth: { authMode: "master", hostNamespace: "*", claims: null },
      };
    }
  }

  // 2. Three-segment JWT shape (only outside disabled JWT mode).
  if (jwtStatus.status !== "disabled" && looksLikeJwt(credential)) {
    if (jwtStatus.status === "invalid") {
      // Fail closed for JWT credentials while the configuration is broken.
      logger.warn("jwt_auth_failed", { sessionId, reason: "jwt_config_invalid" });
      return {
        outcome: "response",
        response: jsonResponse(401, { ok: false, error: "unauthorized" }),
      };
    }
    const verification = await verifyHostJwt(credential, jwtStatus.config, {
      fetchImpl: fetch,
    });
    if (!verification.ok) {
      if (verification.reason === "jwks_unavailable") {
        logger.warn("jwt_auth_failed", { sessionId, reason: verification.reason });
        return {
          outcome: "response",
          response: jsonResponse(503, { ok: false, error: "jwks_unavailable" }),
        };
      }
      logger.warn("jwt_auth_failed", { sessionId, reason: verification.reason });
      return {
        outcome: "response",
        response: jsonResponse(401, { ok: false, error: "unauthorized" }),
      };
    }
    const namespace = verification.claims.namespace;
    if (sessionId !== null && !isNamespaceSessionId(sessionId, namespace)) {
      logger.warn("namespace_prefix_mismatch", { sessionId, namespace });
      return {
        outcome: "response",
        response: jsonResponse(401, { ok: false, error: "unauthorized" }),
      };
    }
    return {
      outcome: "host",
      auth: { authMode: "jwt", hostNamespace: namespace, claims: verification.claims },
    };
  }

  // 3. Static namespace token (token carrier only; a Bearer is never one).
  if (selection.carrier === "token" && namespaceConfig.error === undefined) {
    const namespace = await matchNamespaceToken(credential, namespaceConfig.entries);
    if (namespace !== null) {
      if (sessionId !== null && !isNamespaceSessionId(sessionId, namespace)) {
        logger.warn("namespace_prefix_mismatch", { sessionId, namespace });
        return {
          outcome: "response",
          response: jsonResponse(401, { ok: false, error: "unauthorized" }),
        };
      }
      return {
        outcome: "host",
        auth: { authMode: "namespace", hostNamespace: namespace, claims: null },
      };
    }
  } else if (selection.carrier === "token" && namespaceConfig.error !== undefined) {
    logger.warn("namespace_tokens_invalid", { sessionId, reason: namespaceConfig.error });
    return {
      outcome: "response",
      response: jsonResponse(401, { ok: false, error: "unauthorized" }),
    };
  }

  // 4. No credential path matched.
  logger.warn(
    namespaceConfig.entries.length === 0 ? "master_auth_failed" : "namespace_auth_failed",
    { sessionId },
  );
  return { outcome: "response", response: jsonResponse(401, { ok: false, error: "unauthorized" }) };
}

async function whoamiResponse(request: Request, env: RelayEnv, logger: Logger): Promise<Response> {
  const auth = await resolveHostAuth(request, env, logger, null, null);
  if (auth.outcome === "response") {
    return auth.response;
  }
  if (auth.outcome === "none") {
    logger.warn("whoami_auth_failed", { hasToken: false });
    return jsonResponse(401, { ok: false, error: "unauthorized" });
  }
  const turn = describeTurn(env);
  const turnField = { provider: turn.provider, configured: turn.configured };
  if (auth.auth.authMode === "jwt") {
    const claims = auth.auth.claims;
    return jsonResponse(200, {
      ok: true,
      service: SERVICE_NAME,
      protocolVersion: PROTOCOL_VERSION,
      authMode: "jwt",
      namespace: claims.namespace,
      sub: claims.sub,
      tokenUse: claims.tokenUse,
      scopes: claims.scopes,
      expiresAt: claims.expiresAt,
      turn: turnField,
    });
  }
  if (auth.auth.authMode === "namespace") {
    return jsonResponse(200, {
      ok: true,
      service: SERVICE_NAME,
      protocolVersion: PROTOCOL_VERSION,
      authMode: "namespace",
      namespace: auth.auth.hostNamespace,
      turn: turnField,
    });
  }
  return jsonResponse(200, {
    ok: true,
    service: SERVICE_NAME,
    protocolVersion: PROTOCOL_VERSION,
    authMode: "master",
    turn: turnField,
  });
}

function parseSessionPath(pathname: string): string | null {
  const prefix = "/ws/";
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const raw = pathname.slice(prefix.length);
  if (raw.length === 0) {
    return null;
  }
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return isValidSessionId(sessionId) ? sessionId : null;
}

export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    const url = new URL(request.url);
    const logger = createLogger(env);

    if (url.pathname === "/healthz") {
      if (request.method !== "GET") {
        return jsonResponse(
          405,
          { ok: false, error: "method_not_allowed" },
          {
            allow: "GET",
          },
        );
      }
      return jsonResponse(200, healthPayload());
    }

    if (url.pathname === "/auth/whoami") {
      if (request.method !== "GET") {
        return jsonResponse(
          405,
          { ok: false, error: "method_not_allowed" },
          {
            allow: "GET",
          },
        );
      }
      return whoamiResponse(request, env, logger);
    }

    const isSessionPath = url.pathname.startsWith("/ws/");
    const sessionId = parseSessionPath(url.pathname);
    if (!isSessionPath) {
      return jsonResponse(404, { ok: false, error: "not_found" });
    }
    if (sessionId === null) {
      return jsonResponse(400, { ok: false, error: "invalid_session" });
    }

    if (request.method !== "GET") {
      return jsonResponse(
        405,
        { ok: false, error: "method_not_allowed" },
        {
          allow: "GET",
        },
      );
    }

    const upgrade = request.headers.get("upgrade");
    if (upgrade === null || upgrade.toLowerCase() !== "websocket") {
      return jsonResponse(426, { ok: false, error: "upgrade_required" }, { upgrade: "websocket" });
    }

    // A session token is mandatory for every relay connection. Rejecting it at
    // the edge keeps anonymous pending sockets from reaching a SessionDO.
    const presentedSession = request.headers.get("x-tokimeki-session");
    if (presentedSession === null || presentedSession.length === 0) {
      logger.warn("session_token_missing", { sessionId });
      return jsonResponse(401, { ok: false, error: "unauthorized" });
    }

    const auth = await resolveHostAuth(request, env, logger, sessionId, presentedSession);
    if (auth.outcome === "response") {
      return auth.response;
    }

    // The CLI marks an explicit read-only listener connection. The header is
    // internal: it never reaches the DO, and a host credential always wins so
    // a host cannot accidentally be downgraded to listener.
    let role: "host" | "viewer" | "listener" = "viewer";
    if (auth.outcome === "host") {
      role = "host";
    } else {
      const listenerHeader = request.headers.get("x-tokimeki-listener");
      if (listenerHeader !== null) {
        if (listenerHeader !== "1") {
          logger.warn("invalid_listener_header", { sessionId });
          return jsonResponse(400, { ok: false, error: "invalid_role" });
        }
        role = "listener";
      }
    }
    const hostNamespace = auth.outcome === "host" ? auth.auth.hostNamespace : null;

    const jwtStatus = readJwtAuthConfigCached(env);
    const headers = new Headers(request.headers);
    // Auth/internal headers are deleted before forwarding: the namespace is
    // derived from the verified credential only, and a client-supplied value
    // is never trusted, even for root hosts.
    headers.delete("x-tokimeki-token");
    // The pre-rename host header is not a credential; strip it defensively.
    headers.delete("x-tokimeki-master");
    headers.delete("x-tokimeki-listener");
    headers.delete("x-tokimeki-namespace");
    // Authorization is only ever relevant to the JWT path, and the DO never
    // reads it. In disabled JWT mode it is left untouched (v1.1 behavior).
    if (jwtStatus.status !== "disabled") {
      headers.delete("authorization");
    }
    headers.set("x-tokimeki-role", role);
    if (role === "host" && hostNamespace !== null) {
      headers.set("x-tokimeki-namespace", hostNamespace);
    }

    const forwarded = new Request(request, { headers });
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
    logger.info("relay_dispatch", {
      sessionId,
      role,
      hasToken: presentedSession.length > 0,
      ...(hostNamespace === null ? {} : { namespace: hostNamespace }),
    });
    return stub.fetch(forwarded);
  },
} satisfies ExportedHandler<RelayEnv>;
