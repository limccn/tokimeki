#!/usr/bin/env node
/**
 * v1.2 cross-repo e2e: TokiAPI (invite + Session JWT + WebSocket proxy) ↔
 * tokimeki relay/CLI (Host JWT + Session JWT verification).
 *
 * Assumes:
 *   - TokiAPI is running at TOKIAPI_BASE_URL (default http://localhost:5173)
 *     with TOKIMEKI_JWT_PRIVATE_JWK + TOKIMEKI_RELAY_URL configured;
 *   - the relay is running at TOKIMEKI_RELAY_URL (default ws://localhost:8788)
 *     with TOKIMEKI_JWT_JWKS_URL pointing at TokiAPI and
 *     TOKIMEKI_JWT_ALLOW_HTTP=1 for the loopback http JWKS;
 *   - the tokimeki CLI is built (`npm run build` at the repo root).
 *
 * Flow: anon-host → CLI host (Host JWT) → attach/cli (Session JWT) → CLI viewer
 * → web viewer through the TokiAPI WS proxy (TURN stripped).
 *
 * No token is printed. Exit code 1 on any failed assertion.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFrame, encodeFrame } from "@limccn/tokimeki-protocol";
import WebSocket from "ws";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = process.env.E2E_CLI_ENTRY ?? join(root, "packages/cli/dist/index.js");
const fakeTui = join(root, "scripts/e2e/fake-tui.mjs");
const tokiApiBase = process.env.TOKIAPI_BASE_URL ?? "http://localhost:5173";
const relayUrl = process.env.TOKIMEKI_RELAY_URL ?? "ws://localhost:8788";
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 60_000);

if (!existsSync(cli)) {
  console.error(`CLI entry not found: ${cli} (run npm run build)`);
  process.exit(2);
}

const children = new Set();
const secrets = new Set();

function redact(text) {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join("<redacted>");
  }
  return out;
}

function start(name, args, env) {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  let output = "";
  const onData = (chunk) => {
    output += chunk.toString("utf8");
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.once("exit", () => children.delete(child));
  return {
    name,
    child,
    output: () => output,
    async waitFor(needle, ms = timeoutMs) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (output.includes(needle)) return;
        if (child.exitCode !== null) {
          throw new Error(`${name} exited before "${needle}":\n${redact(output).slice(-4000)}`);
        }
        await sleep(100);
      }
      throw new Error(`${name} timed out waiting for "${needle}":\n${redact(output).slice(-4000)}`);
    },
  };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function jsonFetch(path, init = {}) {
  const response = await fetch(`${tokiApiBase}${path}`, init);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON error body.
  }
  return { response, body, text };
}

function assertIsoTimestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} expiresAt must be an ISO-8601 timestamp`);
  }
}

function codeFromUrl(url) {
  const marker = "#t-";
  const index = url.indexOf(marker);
  if (index < 0) throw new Error("invite URL has no code");
  return url.slice(index + marker.length);
}

async function main() {
  // 1. Anonymous host + invite (public endpoint, no session).
  const anon = await jsonFetch("/api/tokimeki/anon-host", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (anon.response.status !== 200 || anon.body?.success !== true) {
    throw new Error(`anon-host failed: HTTP ${anon.response.status}\n${anon.text}`);
  }
  const { token, namespace, session, inviteUrl, expiresAt } = anon.body;
  assertIsoTimestamp(expiresAt, "anon-host");
  const code = codeFromUrl(inviteUrl);
  secrets.add(token);
  secrets.add(code);
  console.log(`[ok] anon-host session=${session}`);

  // 2. CLI host with the anonymous Host JWT.
  const sessionToken = randomBytes(16).toString("base64url").slice(0, 12);
  const hostEnv = {
    TOKIMEKI_RELAY_URL: relayUrl,
    TOKIMEKI_TOKEN: token,
    TOKIMEKI_NAMESPACE: namespace,
    TOKIMEKI_SESSION: session,
    TOKIMEKI_SESSION_TOKEN: sessionToken,
    TOKIMEKI_P2P: "off",
    TOKIMEKI_LOG_LEVEL: "warn",
  };
  secrets.add(sessionToken);
  const host = start("host", [cli, "run", "--", process.execPath, fakeTui], hostEnv);
  // The host process does not mirror the PTY to its own stdout when it is not
  // attached to a TTY; readiness is proven by the viewer receiving output.
  await host.waitFor("hint: press F12");
  console.log("[ok] CLI host started with the Host JWT");

  // 3. Public attach/cli → Session JWT for the CLI viewer.
  const cliAttach = await jsonFetch("/api/tokimeki/attach/cli", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (cliAttach.response.status !== 200 || typeof cliAttach.body?.token !== "string") {
    throw new Error(`attach/cli failed: HTTP ${cliAttach.response.status}\n${cliAttach.text}`);
  }
  assertIsoTimestamp(cliAttach.body.expiresAt, "attach/cli");
  secrets.add(cliAttach.body.token);
  const viewer = start("viewer", [cli, "attach"], {
    TOKIMEKI_RELAY_URL: relayUrl,
    TOKIMEKI_SESSION: cliAttach.body.session,
    TOKIMEKI_SESSION_TOKEN: cliAttach.body.token,
    TOKIMEKI_P2P: "off",
    TOKIMEKI_LOG_LEVEL: "warn",
  });
  await viewer.waitFor("TOKIMEKI_E2E_READY");
  console.log("[ok] CLI viewer attached with a Session JWT");

  // 4. Web viewer through the TokiAPI WS proxy.
  const webAttach = await jsonFetch("/api/tokimeki/attach", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (webAttach.response.status !== 200) {
    throw new Error(`web attach failed: HTTP ${webAttach.response.status}\n${webAttach.text}`);
  }
  const cookie = (webAttach.response.headers.getSetCookie?.() ?? [])
    .map((entry) => entry.split(";")[0])
    .join("; ");
  if (cookie.length === 0) throw new Error("web attach did not set a ticket cookie");

  const wsUrl = new URL("/api/tokimeki/ws", tokiApiBase);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(wsUrl, {
    headers: { Origin: tokiApiBase, Cookie: cookie },
  });
  await new Promise((resolveOpen, rejectOpen) => {
    ws.once("open", resolveOpen);
    ws.once("error", rejectOpen);
  });
  const clientId = crypto.randomUUID();
  ws.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      role: "viewer",
      session,
      clientId,
      protocolVersion: 1,
      client: { name: "e2e-web", version: "1", kind: "web" },
      capabilities: { display: { modes: ["viewport"] }, transports: { modes: ["relay"] } },
      cols: 100,
      rows: 30,
    }),
  );

  let welcomeText = null;
  let webOutput = "";
  let sawReady = false;
  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("web viewer timed out")), timeoutMs);
    ws.on("message", (data, isBinary) => {
      if (process.env.E2E_DEBUG === "1") {
        console.log(
          `[debug] web ${isBinary ? "binary" : "text"}: ${
            isBinary ? `${data.length}B` : data.toString("utf8").slice(0, 160)
          }`,
        );
      }
      if (isBinary) {
        try {
          const frame = decodeFrame(new Uint8Array(data));
          if (frame.type === "output" || frame.type === "snapshot_to") {
            webOutput += Buffer.from(frame.payload).toString("utf8");
            if (webOutput.includes("TOKIMEKI_E2E_READY")) {
              sawReady = true;
              clearTimeout(timer);
              resolveReady();
            }
          }
        } catch {
          // Ignore unexpected frames.
        }
        return;
      }
      const text = data.toString("utf8");
      if (welcomeText === null) {
        try {
          const parsed = JSON.parse(text);
          if (parsed.type === "welcome") welcomeText = text;
        } catch {
          // Not a control message.
        }
      }
    });
    ws.once("close", (closeCode) => {
      clearTimeout(timer);
      rejectReady(new Error(`web proxy closed (${closeCode})`));
    });
  });
  if (!sawReady) throw new Error("web viewer did not receive terminal output");
  if (welcomeText === null) throw new Error("web viewer received no welcome");
  if (welcomeText.includes("iceServers") || welcomeText.includes("iceProvider")) {
    throw new Error("proxy leaked TURN credentials in welcome");
  }
  console.log("[ok] web viewer rendered output; welcome has no TURN fields");

  // 5. Input through the web viewer reaches the host and both viewers.
  ws.send(encodeFrame({ type: "input", payload: new TextEncoder().encode("x") }));
  await viewer.waitFor("ECHO:x", 15_000);
  const deadline = Date.now() + 15_000;
  while (!webOutput.includes("ECHO:x") && Date.now() < deadline) {
    await sleep(100);
  }
  if (!webOutput.includes("ECHO:x")) {
    throw new Error("web viewer did not receive the echoed input");
  }
  console.log("[ok] web INPUT reached the host and was broadcast to both viewers");

  ws.close();
  viewer.child.kill();
  host.child.kill();
  console.log("PASS v1.2 cross-repo e2e");
}

main()
  .catch((error) => {
    console.error(`FAIL ${redact(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const child of children) {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    }
    // Give kills a moment before the process exits. `ws` / child handles can
    // keep the event loop alive after a failed assertion.
    await sleep(200);
    process.exit(process.exitCode ?? 0);
  });
