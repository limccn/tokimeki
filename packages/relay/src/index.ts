import { isValidSessionId, PROTOCOL_VERSION } from "@limccn/tokimeki-protocol";

import { isMasterTokenValid } from "./auth.js";
import type { RelayEnv } from "./env.js";
import { createLogger } from "./logging.js";
import { describeTurn } from "./turn.js";

export { SessionDurableObject } from "./session-do.js";

const SERVICE_NAME = "tokimeki-relay";

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

function healthPayload(env: RelayEnv): Record<string, unknown> {
  const turn = describeTurn(env);
  return {
    ok: true,
    service: SERVICE_NAME,
    protocolVersion: PROTOCOL_VERSION,
    turnProvider: turn.provider,
    turnConfigured: turn.configured,
  };
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
      return jsonResponse(200, healthPayload(env));
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
    if (presentedMaster !== null) {
      const masterValid = await isMasterTokenValid(presentedMaster, env.TOKIMEKI_MASTER_TOKEN);
      if (!masterValid) {
        logger.warn("master_auth_failed", { sessionId });
        return jsonResponse(401, { ok: false, error: "unauthorized" });
      }
      role = "host";
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
    headers.set("x-tokimeki-role", role);

    const forwarded = new Request(request, { headers });
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
    logger.info("relay_dispatch", {
      sessionId,
      role,
      hasToken: presentedSession.length > 0,
    });
    return stub.fetch(forwarded);
  },
} satisfies ExportedHandler<RelayEnv>;
