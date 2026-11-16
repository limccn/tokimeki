#!/usr/bin/env node
/**
 * Local host-reconnect e2e: prove a host survives a relay WebSocket 1006 and
 * re-attaches with the same client id.
 *
 * Requires a local relay started with `npm run dev:relay` and a plain `ws://`
 * TOKIMEKI_RELAY_URL such as `ws://127.0.0.1:8787`. Pass the development master
 * token from `packages/relay/.dev.vars`:
 *
 *   TOKIMEKI_RELAY_URL=ws://127.0.0.1:8787 \
 *   TOKIMEKI_MASTER_TOKEN=<dev master token> \
 *   node scripts/e2e/host-relay-reconnect.mjs
 *
 * The host connects through a local TCP drop proxy. Dropping only the
 * client-side socket simulates a network blackhole: the host observes close
 * code 1006 while the relay's Durable Object still believes the old socket is
 * OPEN. The script asserts that the reconnecting host is accepted, that the
 * viewer keeps working, and that Ctrl-C still tears the session down cleanly.
 * It never prints tokens.
 *
 * Optional: E2E_TIMEOUT_MS (default 60000), E2E_CLI_ENTRY (CLI entry to run;
 * defaults to the local packages/cli/dist/index.js).
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pty from "@homebridge/node-pty-prebuilt-multiarch";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = process.env.E2E_CLI_ENTRY
  ? resolve(process.env.E2E_CLI_ENTRY)
  : join(root, "packages/cli/dist/index.js");
if (!existsSync(cli)) {
  console.error(`CLI entry not found: ${cli}`);
  process.exit(2);
}
const fakeTui = join(root, "scripts/e2e/fake-tui.mjs");
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 60_000);

const relayUrl = process.env.TOKIMEKI_RELAY_URL;
const masterToken = process.env.TOKIMEKI_MASTER_TOKEN;
const session = process.env.TOKIMEKI_SESSION ?? `host-reconnect-${Date.now()}`;
const sessionToken = process.env.TOKIMEKI_SESSION_TOKEN ?? randomBytes(32).toString("base64url");

if (!relayUrl || !masterToken) {
  console.error("TOKIMEKI_RELAY_URL and TOKIMEKI_MASTER_TOKEN are required");
  process.exit(2);
}

let relayTarget;
try {
  relayTarget = new URL(relayUrl);
} catch {
  console.error("TOKIMEKI_RELAY_URL is not a valid URL");
  process.exit(2);
}
if (relayTarget.protocol !== "ws:") {
  console.error("this e2e requires a plain ws:// relay URL (local `npm run dev:relay`)");
  process.exit(2);
}
if (relayTarget.hostname === "") {
  console.error("TOKIMEKI_RELAY_URL must include a host");
  process.exit(2);
}
const relayPort = Number(relayTarget.port === "" ? 80 : relayTarget.port);
const relayBasePath = relayTarget.pathname.replace(/\/+$/, "");

/**
 * TCP proxy that can hide a client disconnect from the relay.
 *
 * `dropCurrent()` destroys only the client-facing socket. The upstream socket
 * (proxy -> relay) is unpiped, paused, and kept referenced, so the relay never
 * sees a FIN and keeps the old WebSocket marked OPEN -- exactly the stale
 * attachment that used to make the reconnecting host fail with
 * `duplicate_client_id`.
 */
function createDropProxy(targetHost, targetPort) {
  const sockets = new Set();
  const heldUpstreams = new Set();
  let currentClient = null;
  let currentUpstream = null;

  const server = net.createServer((client) => {
    client.setNoDelay(true);
    const upstream = net.connect({ host: targetHost, port: targetPort });
    upstream.setNoDelay(true);
    sockets.add(client);
    sockets.add(upstream);
    currentClient = client;
    currentUpstream = upstream;

    client.on("error", () => {});
    upstream.on("error", () => {});
    client.pipe(upstream, { end: false });
    upstream.pipe(client, { end: false });

    client.on("close", () => {
      sockets.delete(client);
      if (currentClient === client) currentClient = null;
      // Hold the relay side open even after the client is gone.
      heldUpstreams.add(upstream);
      if (currentUpstream === upstream) currentUpstream = null;
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      heldUpstreams.delete(upstream);
      if (currentUpstream === upstream) currentUpstream = null;
    });
  });

  return {
    listen() {
      return new Promise((resolvePromise, rejectPromise) => {
        const onError = (error) => rejectPromise(error);
        server.once("error", onError);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", onError);
          resolvePromise();
        });
      }).then(() => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          throw new Error("drop proxy did not bind a TCP port");
        }
        return address.port;
      });
    },
    dropCurrent() {
      const client = currentClient;
      const upstream = currentUpstream;
      if (client === null || upstream === null) {
        return false;
      }
      currentClient = null;
      currentUpstream = null;
      client.unpipe(upstream);
      upstream.unpipe(client);
      client.destroy();
      upstream.pause();
      heldUpstreams.add(upstream);
      return true;
    },
    close() {
      for (const socket of sockets) socket.destroy();
      for (const upstream of heldUpstreams) upstream.destroy();
      return new Promise((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

const proxy = createDropProxy(relayTarget.hostname, relayPort);
let proxyUrl = null;
const processes = [];
let failed = false;

function start(name, args, env, cols = 80, rows = 24) {
  const child = pty.spawn(process.execPath, [cli, ...args], {
    name: `tokimeki-${name}`,
    cwd: root,
    cols,
    rows,
    env,
    encoding: null,
  });
  const state = {
    name,
    child,
    output: "",
    exited: false,
    exit: null,
    waiters: new Set(),
  };
  processes.push(state);
  child.onData((data) => {
    state.output += Buffer.from(data).toString("utf8");
    for (const waiter of state.waiters) waiter();
  });
  child.onExit((event) => {
    state.exited = true;
    state.exit = event;
    for (const waiter of state.waiters) waiter();
  });
  return state;
}

function stop(state) {
  if (!state || state.exited) return;
  try {
    state.child.kill();
  } catch {
    // best effort
  }
}

function waitFor(state, needle, timeout = timeoutMs, label = needle) {
  return waitForCount(state, needle, 1, timeout, label);
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function waitForCount(state, needle, count, timeout = timeoutMs, label = needle) {
  const check = () => countOccurrences(state.output, needle) >= count;
  if (check()) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      state.waiters.delete(waiter);
      rejectPromise(
        new Error(
          `[${state.name}] timed out waiting for ${count}x ${JSON.stringify(label)}; tail=${JSON.stringify(
            state.output.slice(-1500),
          )}`,
        ),
      );
    }, timeout);
    const waiter = () => {
      if (!check()) return;
      clearTimeout(timer);
      state.waiters.delete(waiter);
      resolvePromise();
    };
    state.waiters.add(waiter);
  });
}

/**
 * Wait for the host's second `relay ready:` after the drop. Fail fast when the
 * old bug resurfaces (fatal duplicate_client_id) instead of burning the full
 * timeout.
 */
async function waitForHostReconnect(host) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (host.output.includes("duplicate_client_id")) {
      throw new Error("host received duplicate_client_id while reconnecting");
    }
    if (countOccurrences(host.output, "relay ready:") >= 2) {
      return;
    }
    if (host.exited) {
      throw new Error(`host exited during relay reconnection (code=${host.exit?.exitCode})`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(
    `[host] timed out waiting for relay reconnect; tail=${JSON.stringify(
      host.output.slice(-1500),
    )}`,
  );
}

function waitExit(state, timeout = 10_000) {
  if (state.exited) return Promise.resolve(state.exit);
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error(`[${state.name}] did not exit`)),
      timeout,
    );
    const waiter = () => {
      if (!state.exited) return;
      clearTimeout(timer);
      state.waiters.delete(waiter);
      resolvePromise(state.exit);
    };
    state.waiters.add(waiter);
  });
}

function commonEnv(relay) {
  return {
    ...process.env,
    TOKIMEKI_RELAY_URL: relay,
    TOKIMEKI_MASTER_TOKEN: masterToken,
    TOKIMEKI_SESSION: session,
    TOKIMEKI_SESSION_TOKEN: sessionToken,
    TOKIMEKI_TERM: "xterm-256color",
    TOKIMEKI_COLORTERM: "truecolor",
    TOKIMEKI_HEARTBEAT_SECONDS: "10",
    TOKIMEKI_SCROLLBACK_LINES: "1000",
    TOKIMEKI_SNAPSHOT_MAX_BYTES: "262144",
    TOKIMEKI_P2P: "off",
    TOKIMEKI_ICE_TRANSPORT_POLICY: "all",
    TOKIMEKI_LOG_LEVEL: "debug",
  };
}

function pass(message) {
  console.log(`PASS ${message}`);
}

async function main() {
  const port = await proxy.listen();
  proxyUrl = `ws://127.0.0.1:${port}${relayBasePath}`;
  console.log(`session=${session} relay=${relayUrl} proxy=${proxyUrl}`);

  const host = start("host", ["run", "--", process.execPath, fakeTui], commonEnv(proxyUrl), 90, 28);
  await waitFor(host, "relay ready:", timeoutMs, "host relay ready");
  await waitFor(host, "TOKIMEKI_E2E_READY", timeoutMs, "host fake TUI ready");
  pass("host connected to the relay through the drop proxy");

  // The viewer bypasses the proxy so only the host's transport is dropped.
  const viewer = start("viewer", ["attach"], commonEnv(relayUrl), 80, 24);
  await waitFor(viewer, "TOKIMEKI_E2E_READY", timeoutMs, "viewer initial snapshot");
  pass("viewer received the initial snapshot");

  viewer.child.write("before-drop\r");
  await waitFor(viewer, "ECHO:before-drop", timeoutMs, "baseline input echo");
  await waitFor(host, "ECHO:before-drop", timeoutMs, "baseline input at the PTY");
  pass("baseline viewer input reached the host PTY");

  if (!proxy.dropCurrent()) {
    throw new Error("drop proxy had no active connection to drop");
  }
  pass("dropped the client-side TCP connection; relay side stays open");

  await waitFor(host, "relay disconnected (code 1006)", timeoutMs, "host sees close 1006");
  pass("host observed a 1006 disconnect");

  await waitForHostReconnect(host);
  pass("host reconnected with the same client id; no duplicate_client_id");
  console.log("RECONNECT_PASS");

  viewer.child.write("after-reconnect\r");
  await waitFor(viewer, "ECHO:after-reconnect", timeoutMs, "post-reconnect input echo");
  await waitFor(host, "ECHO:after-reconnect", timeoutMs, "post-reconnect input at the PTY");
  pass("viewer input reached the reconnected host and echoed back to the viewer");

  viewer.child.write("\u0003");
  await waitFor(host, "PTY exited (code=0)", 15_000, "host PTY exit");
  await waitFor(viewer, "host exited (code=0)", timeoutMs, "viewer host-exited");
  const hostExit = await waitExit(host, 15_000);
  const viewerExit = await waitExit(viewer, 10_000);
  if (hostExit.exitCode !== 0) {
    throw new Error(`host exited with code ${hostExit.exitCode}`);
  }
  if (viewerExit.exitCode !== 0) {
    throw new Error(`viewer exited with code ${viewerExit.exitCode}`);
  }
  pass("Ctrl-C propagated to the PTY; host and viewer exited 0");
}

main()
  .then(() => {
    console.log("E2E PASS");
  })
  .catch((error) => {
    failed = true;
    console.error(`E2E FAIL: ${error instanceof Error ? error.message : String(error)}`);
    for (const state of processes) {
      console.error(`--- ${state.name} tail ---\n${state.output.slice(-3000)}`);
    }
  })
  .finally(() => {
    for (const state of processes) stop(state);
    proxy
      .close()
      .catch(() => {})
      .finally(() => {
        setTimeout(() => process.exit(failed ? 1 : 0), 300);
      });
  });
