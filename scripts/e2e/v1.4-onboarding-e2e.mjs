#!/usr/bin/env node
/**
 * v1.4 onboarding end-to-end test (local, self-contained).
 *
 * Starts a local `wrangler dev` relay with a static namespace token, a mock
 * TokiAPI provider, then verifies:
 *   - `tokimeki --config <v2 envelope> run -- ...` hosts without prompts;
 *   - daemon `ready` events on stderr (host and attach) and the JSON event
 *     prefix;
 *   - the v2 `passcode` field is applied (an attach without the passcode is
 *     rejected, then succeeds with it);
 *   - `tokimeki attach <share-url>` exchanges through /api/config +
 *     /api/tokimeki/attach/cli and attaches on the same relay;
 *   - no config/history files are written for the share-URL path;
 *   - the Workers Static Assets onboarding page is served at `/` while
 *     `/healthz` and `/auth/whoami` stay Worker routes;
 *   - `tokimeki acp list` covers the nine ACP commands.
 *
 * Environment:
 *   E2E_TIMEOUT_MS   default 90000
 *   E2E_DUMP_DIR     optional directory for child output on failure
 *
 * Requires a prior `npm run build` (CLI dist) and `npm run build:site`.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = process.env.E2E_CLI_ENTRY
  ? resolve(process.env.E2E_CLI_ENTRY)
  : join(root, "packages/cli/dist/index.js");
const fakeTui = join(root, "scripts/e2e/fake-tui.mjs");
const siteIndex = join(root, "packages/onboarding-site/dist/index.html");
const wranglerBin = join(root, "node_modules/wrangler/bin/wrangler.js");
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 90_000);

for (const [label, path] of [
  ["CLI build", cli],
  ["onboarding site build", siteIndex],
  ["wrangler", wranglerBin],
  ["fake TUI", fakeTui],
]) {
  if (!existsSync(path)) {
    console.error(`${label} not found: ${path} (run npm run build && npm run build:site)`);
    process.exit(2);
  }
}

const children = new Set();
function track(child) {
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

function killAll() {
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // best effort
    }
  }
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolvePort(port) : reject(new Error("no port"))));
    });
    server.on("error", reject);
  });
}

function collect(child) {
  const state = { stdout: "", stderr: "", code: null };
  child.stdout?.on("data", (chunk) => {
    state.stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk) => {
    state.stderr += chunk.toString("utf8");
  });
  child.on("exit", (code) => {
    state.code = code;
  });
  return state;
}

async function waitFor(predicate, description, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function eventLines(stderr) {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("tokimeki-event: "))
    .map((line) => JSON.parse(line.slice("tokimeki-event: ".length)));
}

function childEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) {
    if (key.startsWith("TOKIMEKI_")) delete env[key];
  }
  return { ...env, ...extra };
}

function spawnCli(args, env, options = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...options,
  });
  track(child);
  return child;
}

async function httpJson(url, init) {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function main() {
  const relayPort = await freePort();
  const providerPort = await freePort();
  const home = mkdtempSync(join(tmpdir(), "tokimeki-v14-e2e-"));
  const work = mkdtempSync(join(tmpdir(), "tokimeki-v14-work-"));
  const hostToken = "host-token-0123456789abcdef0123456789abcdef";
  const namespace = "ab12";
  const sessionToken = "viewer-token-0123456789abcdef0123456789";
  const passcode = "123456";
  const session = `${namespace}.onboarding-${Date.now()}`;
  const relayUrl = `ws://127.0.0.1:${relayPort}`;
  const providerOrigin = `http://127.0.0.1:${providerPort}`;

  const relay = spawn(
    process.execPath,
    [
      wranglerBin,
      "dev",
      "--config",
      "wrangler.jsonc",
      "--port",
      String(relayPort),
      "--ip",
      "127.0.0.1",
      "--var",
      `TOKIMEKI_NAMESPACE_TOKENS:${JSON.stringify({ [namespace]: hostToken })}`,
      "--var",
      "TOKIMEKI_LOG_LEVEL:debug",
    ],
    { cwd: root, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  track(relay);
  const relayOutput = collect(relay);

  const provider = createServer((request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && request.url === "/api/config") {
      send(200, { tokimekiEnabled: true, tokimekiRelayUrl: relayUrl });
      return;
    }
    if (request.method === "POST" && request.url === "/api/tokimeki/attach/cli") {
      let raw = "";
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        const body = raw.length > 0 ? JSON.parse(raw) : {};
        if (typeof body.code !== "string" || body.code.length === 0) {
          send(410, { error: { message: "invalid or expired invite" } });
          return;
        }
        send(200, {
          success: true,
          token: sessionToken,
          session,
          mode: "viewer",
          allowWeb: true,
          passcodeRequired: true,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        });
      });
      return;
    }
    send(404, { error: { message: "not found" } });
  });
  await new Promise((resolveListen) => provider.listen(providerPort, "127.0.0.1", resolveListen));

  try {
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${relayPort}/healthz`);
        return response.ok;
      } catch {
        return false;
      }
    }, "local relay /healthz");

    // Static assets and Worker routes.
    const page = await fetch(`http://127.0.0.1:${relayPort}/`);
    const pageText = await page.text();
    assert(page.status === 200, `site status ${page.status}`);
    assert(pageText.includes("no-JWT onboarding"), "site marker missing");
    assert(pageText.includes("connect-src 'none'"), "CSP missing");
    const health = await httpJson(`http://127.0.0.1:${relayPort}/healthz`);
    assert(health.status === 200 && health.body?.ok === true, "healthz regression");
    const whoami = await fetch(`http://127.0.0.1:${relayPort}/auth/whoami`);
    assert(whoami.status === 401, `whoami status ${whoami.status}`);

    // ACP list.
    const acp = spawnCli(["acp", "list"], childEnv(home));
    const acpOut = collect(acp);
    await waitFor(() => acpOut.code !== null, "acp list exit");
    assert(acpOut.code === 0, `acp list exit ${acpOut.code}`);
    for (const command of [
      "claude",
      "pi",
      "codex",
      "gemini",
      "cursor",
      "aider",
      "opencode",
      "goose",
      "amp",
    ]) {
      assert(acpOut.stdout.includes(command), `acp list missing ${command}`);
    }

    // Daemon config error event.
    const badAttach = spawnCli(["attach"], childEnv(home));
    const badOut = collect(badAttach);
    await waitFor(() => badOut.code !== null, "daemon error exit");
    assert(badOut.code === 2, `daemon config error exit ${badOut.code}`);
    const badEvents = eventLines(badOut.stderr);
    assert(
      badEvents.some((event) => event.type === "error" && event.code === "config_invalid"),
      "missing config_invalid event",
    );

    // Host from a downloaded v2 config file.
    const configPath = join(work, "tokimeki-config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        v: 2,
        relayUrl,
        token: hostToken,
        namespace,
        session,
        sessionToken,
        passcode,
        windowSize: "100x30",
      }),
      { mode: 0o600 },
    );
    const host = spawnCli(
      ["--daemon", "--config", configPath, "run", "--", process.execPath, fakeTui],
      childEnv(home),
    );
    const hostOut = collect(host);
    const hostReady = await waitFor(
      () => {
        const event = eventLines(hostOut.stderr).find(
          (entry) => entry.type === "ready" && entry.command === "host",
        );
        return event ?? false;
      },
      "host ready event",
      60_000,
    );
    assert(hostReady.role === "host" && hostReady.session === session, "host ready fields");

    // The v2 config's passcode must reach the relay verifier: a manual viewer
    // without TOKIMEKI_PASSCODE is rejected.
    const denied = spawnCli(
      ["attach"],
      childEnv(home, {
        TOKIMEKI_RELAY_URL: relayUrl,
        TOKIMEKI_SESSION: session,
        TOKIMEKI_SESSION_TOKEN: sessionToken,
      }),
    );
    const deniedOut = collect(denied);
    await waitFor(() => deniedOut.code !== null, "passcode-denied exit", 30_000);
    assert(deniedOut.code !== 0, "viewer without passcode unexpectedly succeeded");
    assert(
      deniedOut.stderr.includes("passcode"),
      `expected passcode failure, got: ${deniedOut.stderr.slice(-400)}`,
    );

    // Viewer with the passcode attaches via the share URL.
    const viewer = spawnCli(
      ["--daemon", "attach", `${providerOrigin}/#t-ok`],
      childEnv(home, { TOKIMEKI_PASSCODE: passcode }),
    );
    const viewerOut = collect(viewer);
    const viewerReady = await waitFor(
      () => {
        const event = eventLines(viewerOut.stderr).find(
          (entry) => entry.type === "ready" && entry.command === "attach",
        );
        return event ?? false;
      },
      "viewer ready event",
      60_000,
    );
    assert(viewerReady.role === "viewer" && viewerReady.session === session, "viewer ready fields");
    await waitFor(
      () => viewerOut.stdout.includes("TOKIMEKI_E2E_READY"),
      "viewer terminal snapshot",
      30_000,
    );

    // Secrets must not appear in daemon output.
    for (const secret of [hostToken, sessionToken, passcode]) {
      for (const [label, state] of [
        ["host", hostOut],
        ["viewer", viewerOut],
      ]) {
        assert(!state.stderr.includes(secret), `${label} stderr leaked a secret`);
      }
    }

    // The share-URL path must not persist config/history.
    const homeConfig = join(home, ".tokimeki");
    assert(!existsSync(homeConfig), "share-url attach wrote ~/.tokimeki state");

    // Ctrl-C reaches the hosted fake TUI and ends the session.
    viewer.stdin.write("\x03");
    await waitFor(() => viewerOut.code !== null, "viewer exit", 30_000);
    await waitFor(() => hostOut.code !== null, "host exit", 30_000);
    assert(hostOut.code === 0, `host exit ${hostOut.code}`);

    console.log("v1.4 onboarding e2e: PASS");
  } catch (error) {
    console.error(`v1.4 onboarding e2e: FAIL: ${error instanceof Error ? error.message : error}`);
    if (process.env.E2E_DUMP_DIR) {
      mkdirSync(process.env.E2E_DUMP_DIR, { recursive: true });
      writeFileSync(
        join(process.env.E2E_DUMP_DIR, "relay.log"),
        relayOutput.stdout + relayOutput.stderr,
      );
    }
    process.exitCode = 1;
  } finally {
    killAll();
    provider.close();
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await main();
