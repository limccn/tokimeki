import { isValidSessionId, PROTOCOL_VERSION } from "@limccn/tokimeki-protocol";

import { isMasterTokenValid } from "./auth.js";
import type { RelayEnv } from "./env.js";
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

/**
 * Authenticated operational probe (v1: root master only).
 *
 * Opaque session tokens cannot be verified on their own, so they are not
 * accepted here; Host/Session JWT support belongs to the v1.2 rewrite.
 */
async function whoamiResponse(request: Request, env: RelayEnv, logger: Logger): Promise<Response> {
  const presentedMaster = request.headers.get("x-tokimeki-master");
  const valid = await isMasterTokenValid(presentedMaster, env.TOKIMEKI_MASTER_TOKEN);
  if (!valid) {
    logger.warn("whoami_auth_failed", {
      hasToken: presentedMaster !== null && presentedMaster.length > 0,
    });
    return jsonResponse(401, { ok: false, error: "unauthorized" });
  }
  const turn = describeTurn(env);
  return jsonResponse(200, {
    ok: true,
    service: SERVICE_NAME,
    protocolVersion: PROTOCOL_VERSION,
    authMode: "master",
    turn: { provider: turn.provider, configured: turn.configured },
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

    const presentedMaster = request.headers.get("x-tokimeki-master");
    // A session token must never double as the host master token: a viewer
    // already holds the session token and could otherwise claim the host role.
    if (
      presentedMaster !== null &&
      presentedMaster.length > 0 &&
      presentedMaster === presentedSession
    ) {
      logger.warn("master_session_token_equal", { sessionId });
      return jsonResponse(401, { ok: false, error: "unauthorized" });
    }
    // The CLI marks an explicit read-only listener connection. The header is
    // internal: it never reaches the DO, and the master token always wins so a
    // host cannot accidentally be downgraded to listener.
    const listenerHeader = request.headers.get("x-tokimeki-listener");
    let role: "host" | "viewer" | "listener" = "viewer";
    // `"*"` is the root master's namespace; `null` means a non-host connection.
    let hostNamespace: string | null = null;
    if (presentedMaster !== null) {
      if (await isMasterTokenValid(presentedMaster, env.TOKIMEKI_MASTER_TOKEN)) {
        // Root/break-glass host: any valid session id, any namespace.
        role = "host";
        hostNamespace = "*";
      } else {
        // Static namespace tokens are the OSS multi-user path. A provided host
        // token must match exactly one namespace token; anything else is 401.
        const namespaceConfig = namespaceTokenConfig(
          env.TOKIMEKI_NAMESPACE_TOKENS,
          env.TOKIMEKI_MASTER_TOKEN,
        );
        if (namespaceConfig.error !== undefined) {
          logger.warn("namespace_tokens_invalid", {
            sessionId,
            reason: namespaceConfig.error,
          });
          return jsonResponse(401, { ok: false, error: "unauthorized" });
        }
        const namespace = await matchNamespaceToken(presentedMaster, namespaceConfig.entries);
        if (namespace === null) {
          logger.warn(
            namespaceConfig.entries.length === 0 ? "master_auth_failed" : "namespace_auth_failed",
            { sessionId },
          );
          return jsonResponse(401, { ok: false, error: "unauthorized" });
        }
        // A namespace host may only ever touch `<namespace>.<slug>`. This is
        // the wire-level isolation boundary; the DO re-checks before trusting
        // the internal namespace header.
        if (!isNamespaceSessionId(sessionId, namespace)) {
          logger.warn("namespace_prefix_mismatch", { sessionId, namespace });
          return jsonResponse(401, { ok: false, error: "unauthorized" });
        }
        role = "host";
        hostNamespace = namespace;
      }
    } else if (listenerHeader !== null) {
      if (listenerHeader !== "1") {
        logger.warn("invalid_listener_header", { sessionId });
        return jsonResponse(400, { ok: false, error: "invalid_role" });
      }
      role = "listener";
    }

    const headers = new Headers(request.headers);
    headers.delete("x-tokimeki-master");
    headers.delete("x-tokimeki-listener");
    // The namespace is derived from the presented token only; a client-supplied
    // header is never trusted, even for root hosts.
    headers.delete("x-tokimeki-namespace");
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
