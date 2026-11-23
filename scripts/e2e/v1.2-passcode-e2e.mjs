#!/usr/bin/env node
/**
 * v1.2 passcode cross-repo e2e (tokimeki D ↔ TokiAPI proxy).
 *
 * Creates a passcodeRequired invite directly in the local TokiAPI D1 (no
 * logged-in user needed), mints a Host JWT with the local signing key, then:
 *   - starts a CLI host with TOKIMEKI_PASSCODE;
 *   - attaches a CLI viewer with the correct passcode (must work);
 *   - attaches a second CLI viewer without a passcode (must fail);
 *   - opens the web viewer through the TokiAPI proxy: the first WS frame is
 *     the passcode, then hello; verifies output and that a wrong passcode is
 *     rejected.
 *
 * Required environment:
 *   TOKIMEKI_JWT_PRIVATE_JWK  same private JWK the TokiAPI dev server uses
 *   TOKIAPI_BASE_URL          default http://localhost:5173
 *   TOKIMEKI_RELAY_URL        default ws://localhost:8788
 *   TOKIAPI_REPO              default ../cf-ai-gateway relative to tokimeki
 *
 * Servers must already be running (see docs/web-viewer.md).
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, createPrivateKey, randomBytes, randomUUID, sign } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFrame } from "@limccn/tokimeki-protocol";
import WebSocket from "ws";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = process.env.E2E_CLI_ENTRY ?? join(root, "packages/cli/dist/index.js");
const fakeTui = join(root, "scripts/e2e/fake-tui.mjs");
const tokiApiBase = process.env.TOKIAPI_BASE_URL ?? "http://localhost:5173";
const relayUrl = process.env.TOKIMEKI_RELAY_URL ?? "ws://localhost:8788";
const tokiApiRepo = resolve(process.env.TOKIAPI_REPO ?? join(root, "..", "cf-ai-gateway"));
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 60_000);
const passcode = process.env.E2E_PASSCODE ?? "e2e-pass-123456";
const codeCharset = "2356789abcdefghjkmnpqrstuvwxyz";

if (!existsSync(cli)) {
  console.error(`CLI entry not found: ${cli} (run npm run build)`);
  process.exit(2);
}
const jwkRaw = process.env.TOKIMEKI_JWT_PRIVATE_JWK;
if (jwkRaw === undefined || jwkRaw.trim().length === 0) {
  console.error("TOKIMEKI_JWT_PRIVATE_JWK is required");
  process.exit(2);
}

const children = new Set();
const secrets = new Set([passcode]);

function redact(text) {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join("<redacted>");
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function randomCode(length) {
  const bytes = randomBytes(length * 2);
  let out = "";
  let index = 0;
  while (out.length < length) {
    if (index >= bytes.length) return randomCode(length);
    const byte = bytes[index];
    index += 1;
    if (byte >= 240) continue;
    out += codeCharset[byte % codeCharset.length];
  }
  return out;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function signHostJwt(namespace, nowSeconds) {
  const jwk = JSON.parse(jwkRaw);
  const key = createPrivateKey({ key: jwk, format: "jwk" });
  const header = { alg: "ES256", typ: "JWT", kid: jwk.kid };
  const payload = {
    iss: tokiApiBase,
    aud: "tokimeki-relay",
    sub: "e2e-passcode-host",
    namespace,
    token_use: "host",
    scope: "host",
    iat: nowSeconds - 10,
    nbf: nowSeconds - 10,
    exp: nowSeconds + 3600,
    jti: randomUUID(),
  };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = sign("sha256", Buffer.from(input), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${base64url(signature)}`;
}

function insertInvite({ namespace, session, codeHash, passcodeRequired }) {
  const sqlFile = join(tmpdir(), `tokimeki-passcode-e2e-${randomUUID()}.sql`);
  writeFileSync(
    sqlFile,
    `INSERT INTO tokimeki_invites
       (code_hash, created_by, namespace, session, mode, allow_web, passcode_required,
        created_at, expires_at, revoked_at)
     VALUES
       ('${codeHash}', NULL, '${namespace}', '${session}', 'viewer', 1, ${passcodeRequired ? 1 : 0},
        unixepoch(), unixepoch() + 3600, NULL);\n`,
    "utf8",
  );
  const wrangler = join(tokiApiRepo, "node_modules/wrangler/bin/wrangler.js");
  const result = spawnSync(
    process.execPath,
    [wrangler, "d1", "execute", "DB", "--local", "--config", "wrangler.jsonc", "--file", sqlFile],
    { cwd: tokiApiRepo, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`D1 insert failed:\n${result.stdout}\n${result.stderr}`);
  }
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
    async waitForExit(ms = 15_000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) return child.exitCode;
        await sleep(100);
      }
      throw new Error(`${name} did not exit:\n${redact(output).slice(-4000)}`);
    },
  };
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

function waitForJson(ws, predicate, ms = timeoutMs) {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for a control frame"));
    }, ms);
    const onMessage = (data, isBinary) => {
      if (isBinary) return;
      let parsed;
      try {
        parsed = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (predicate(parsed)) {
        cleanup();
        resolveMessage(parsed);
      }
    };
    const onClose = (code) => {
      cleanup();
      reject(new Error(`websocket closed (${code})`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
    };
    ws.on("message", onMessage);
    ws.once("close", onClose);
  });
}

async function webConnect(
  code,
  passcodeValue,
  { gate = false, expectFlag = true, sendHello = true } = {},
) {
  const attach = await jsonFetch("/api/tokimeki/attach", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (attach.response.status !== 200) {
    throw new Error(`web attach failed: HTTP ${attach.response.status}\n${attach.text}`);
  }
  if (expectFlag && attach.body?.passcodeRequired !== true) {
    throw new Error("attach did not report passcodeRequired=true");
  }
  if (!expectFlag && attach.body?.passcodeRequired !== false) {
    throw new Error("attach did not report passcodeRequired=false");
  }
  const cookie = (attach.response.headers.getSetCookie?.() ?? [])
    .map((entry) => entry.split(";")[0])
    .join("; ");
  if (cookie.length === 0) throw new Error("no ticket cookie");
  const wsUrl = new URL("/api/tokimeki/ws", tokiApiBase);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  if (gate) wsUrl.searchParams.set("gate", "1");
  const ws = new WebSocket(wsUrl, { headers: { Origin: tokiApiBase, Cookie: cookie } });
  await new Promise((resolveOpen, rejectOpen) => {
    ws.once("open", resolveOpen);
    ws.once("error", rejectOpen);
  });
  if (passcodeValue !== null) {
    ws.send(JSON.stringify({ v: 1, type: "passcode", value: passcodeValue }));
  }
  if (!sendHello) return ws;
  ws.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      role: "viewer",
      session: currentSession,
      clientId: randomUUID(),
      protocolVersion: 1,
      client: { name: "e2e-passcode-web", version: "1", kind: "web" },
      capabilities: { display: { modes: ["viewport"] }, transports: { modes: ["relay"] } },
      cols: 100,
      rows: 30,
    }),
  );
  return ws;
}

let currentSession = "";

async function main() {
  const namespace = "pc001";
  currentSession = `${namespace}.e2e${Date.now().toString(36)}`;
  const code = randomCode(16);
  const codeHash = createHash("sha256").update(code).digest("hex");
  secrets.add(code);
  insertInvite({ namespace, session: currentSession, codeHash, passcodeRequired: true });
  console.log(`[ok] inserted passcodeRequired invite session=${currentSession}`);

  const hostJwt = signHostJwt(namespace, Math.floor(Date.now() / 1000));
  secrets.add(hostJwt);
  const sessionToken = randomBytes(16).toString("base64url").slice(0, 12);
  secrets.add(sessionToken);
  const host = start("host", [cli, "run", "--", process.execPath, fakeTui], {
    TOKIMEKI_RELAY_URL: relayUrl,
    TOKIMEKI_TOKEN: hostJwt,
    TOKIMEKI_NAMESPACE: namespace,
    TOKIMEKI_SESSION: currentSession,
    TOKIMEKI_SESSION_TOKEN: sessionToken,
    TOKIMEKI_PASSCODE: passcode,
    TOKIMEKI_P2P: "off",
    TOKIMEKI_LOG_LEVEL: "warn",
  });
  await host.waitFor("hint: press F12");
  console.log("[ok] host started with TOKIMEKI_PASSCODE");

  const cliAttach = await jsonFetch("/api/tokimeki/attach/cli", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (cliAttach.response.status !== 200) {
    throw new Error(`attach/cli failed: HTTP ${cliAttach.response.status}\n${cliAttach.text}`);
  }
  secrets.add(cliAttach.body.token);

  const goodViewer = start("viewer-with-passcode", [cli, "attach"], {
    TOKIMEKI_RELAY_URL: relayUrl,
    TOKIMEKI_SESSION: currentSession,
    TOKIMEKI_SESSION_TOKEN: cliAttach.body.token,
    TOKIMEKI_PASSCODE: passcode,
    TOKIMEKI_P2P: "off",
    TOKIMEKI_LOG_LEVEL: "warn",
  });
  await goodViewer.waitFor("TOKIMEKI_E2E_READY");
  console.log("[ok] CLI viewer with the correct passcode attached");

  const badViewer = start("viewer-without-passcode", [cli, "attach"], {
    TOKIMEKI_RELAY_URL: relayUrl,
    TOKIMEKI_SESSION: currentSession,
    TOKIMEKI_SESSION_TOKEN: cliAttach.body.token,
    TOKIMEKI_P2P: "off",
    TOKIMEKI_LOG_LEVEL: "warn",
  });
  const exitCode = await badViewer.waitForExit();
  if (exitCode === 0 || !/passcode/i.test(badViewer.output())) {
    throw new Error(
      `viewer without passcode did not fail with a passcode error:\n${redact(badViewer.output())}`,
    );
  }
  console.log("[ok] CLI viewer without a passcode was rejected");

  const okWs = await webConnect(code, passcode);
  const welcome = await waitForJson(okWs, (message) => message.type === "welcome");
  if (
    JSON.stringify(welcome).includes("iceServers") ||
    JSON.stringify(welcome).includes("iceProvider")
  ) {
    throw new Error("welcome leaked TURN fields");
  }
  let sawOutput = false;
  await new Promise((resolveOutput, rejectOutput) => {
    const timer = setTimeout(
      () => rejectOutput(new Error("web viewer received no output")),
      timeoutMs,
    );
    okWs.on("message", (data, isBinary) => {
      if (!isBinary) return;
      try {
        const frame = decodeFrame(new Uint8Array(data));
        if (
          (frame.type === "output" || frame.type === "snapshot_to") &&
          Buffer.from(frame.payload).toString("utf8").includes("TOKIMEKI_E2E_READY")
        ) {
          sawOutput = true;
          clearTimeout(timer);
          resolveOutput();
        }
      } catch {
        // Ignore malformed frames.
      }
    });
  });
  if (!sawOutput) throw new Error("web viewer did not receive the terminal snapshot");
  console.log("[ok] web viewer passed the passcode gate and rendered output");

  const badWs = await webConnect(code, "000000");
  const errorFrame = await waitForJson(badWs, (message) => message.type === "error", 15_000);
  if (errorFrame.code !== "passcode_invalid" && errorFrame.code !== "passcode_locked") {
    throw new Error(`unexpected wrong-passcode error: ${JSON.stringify(errorFrame)}`);
  }
  console.log(`[ok] web viewer with a wrong passcode was rejected (${errorFrame.code})`);

  // 6. Invite flag false + host passcode: the first hello is rejected, then the
  //    browser retries with ?gate=1 and the passcode as the first frame.
  const codeNoFlag = randomCode(16);
  secrets.add(codeNoFlag);
  insertInvite({
    namespace,
    session: currentSession,
    codeHash: createHash("sha256").update(codeNoFlag).digest("hex"),
    passcodeRequired: false,
  });
  const noFlagWs = await webConnect(codeNoFlag, null, { expectFlag: false });
  const noFlagError = await waitForJson(noFlagWs, (message) => message.type === "error", 15_000);
  if (noFlagError.code !== "passcode_required") {
    throw new Error(
      `expected passcode_required without a gate, got ${JSON.stringify(noFlagError)}`,
    );
  }
  noFlagWs.close();
  const retryWs = await webConnect(codeNoFlag, passcode, { expectFlag: false, gate: true });
  await waitForJson(retryWs, (message) => message.type === "welcome");
  console.log("[ok] flag-false invite recovered through the ?gate=1 passcode retry");
  retryWs.close();

  okWs.close();
  badWs.close();
  goodViewer.child.kill();
  badViewer.child.kill();
  host.child.kill();
  console.log("PASS v1.2 passcode cross-repo e2e");
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
    await sleep(200);
    process.exit(process.exitCode ?? 0);
  });
