#!/usr/bin/env node
/**
 * Production smoke test for authenticated host socket replacement.
 *
 * Requires:
 *   TOKIMEKI_RELAY_URL     wss://relay.tokiapi.app (or any deployed worker root)
 *   TOKIMEKI_MASTER_TOKEN  production master token
 *
 * The script creates a throwaway session and connects two hosts with the same
 * client id and session token. The second connection must replace the first:
 * the new socket gets a welcome and the old socket is closed with
 * `duplicate_client_id` (4003). No token is ever printed.
 */

import { randomBytes, randomUUID } from "node:crypto";
import WebSocket from "ws";

const relayUrl = process.env.TOKIMEKI_RELAY_URL;
const masterToken = process.env.TOKIMEKI_MASTER_TOKEN;
if (!relayUrl || !masterToken) {
  console.error("TOKIMEKI_RELAY_URL and TOKIMEKI_MASTER_TOKEN are required");
  process.exit(2);
}

// Cross-border links to relay.tokiapi.app can stall for ~30s; keep the
// handshake budget configurable so a slow but healthy connection still passes.
const openTimeoutMs = Number(process.env.REPLACE_OPEN_TIMEOUT_MS ?? 15_000);
const session = `smoke-replace-${Date.now()}`;
const sessionToken = randomBytes(32).toString("base64url");
const clientId = `host-${randomUUID()}`;
const wsUrl = `${relayUrl.replace(/\/+$/, "")}/ws/${encodeURIComponent(session)}`;

function monitor(ws, label) {
  const state = {
    label,
    controls: [],
    close: null,
    waiters: [],
  };
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let message;
    try {
      message = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    state.controls.push(message);
    for (const waiter of state.waiters.splice(0)) {
      if (waiter.predicate(message)) {
        waiter.resolve(message);
      } else {
        state.waiters.push(waiter);
      }
    }
  });
  ws.on("close", (code, reason) => {
    state.close = { code, reason: reason.toString("utf8") };
  });
  return state;
}

function waitFor(state, predicate, timeoutMs, label) {
  const existing = state.controls.find(predicate);
  if (existing !== undefined) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.waiters = state.waiters.filter((waiter) => waiter !== entry);
      reject(new Error(`${state.label}: timed out waiting for ${label}`));
    }, timeoutMs);
    const entry = {
      predicate,
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      },
    };
    state.waiters.push(entry);
  });
}

async function waitForClose(state, timeoutMs) {
  const started = Date.now();
  while (state.close === null) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`${state.label}: timed out waiting for close`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return state.close;
}

async function openHost(label) {
  const ws = new WebSocket(wsUrl, {
    headers: {
      "X-Tokimeki-Master": masterToken,
      "X-Tokimeki-Session": sessionToken,
    },
    handshakeTimeout: openTimeoutMs,
    perMessageDeflate: false,
  });
  const state = monitor(ws, label);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: open timeout`)), openTimeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${label}: ${error.message}`));
    });
  });
  ws.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      role: "host",
      session,
      clientId,
      protocolVersion: 1,
      capabilities: {},
      cols: 80,
      rows: 24,
    }),
  );
  const welcome = await waitFor(
    state,
    (message) => message.type === "welcome",
    openTimeoutMs,
    "welcome",
  );
  return { ws, state, welcome };
}

const first = await openHost("host-1");
const second = await openHost("host-2");

const replaced = await waitFor(
  first.state,
  (message) => message.type === "error" && message.code === "duplicate_client_id",
  15_000,
  "duplicate_client_id",
);
const close = await waitForClose(first.state, 15_000);

if (close.code !== 4003) {
  throw new Error(`host-1: expected close 4003, got ${close.code}`);
}
if (second.welcome.hostOnline !== true) {
  throw new Error("host-2: welcome did not report hostOnline=true");
}
const clients = Array.isArray(second.welcome.clients) ? second.welcome.clients : [];
if (clients.some((client) => client.clientId === clientId)) {
  throw new Error("host-2: welcome still lists the replaced host");
}

console.log("PASS first host connected");
console.log("PASS second host with same client id received welcome (hostOnline=true)");
console.log(`PASS first host replaced (${replaced.code}, close ${close.code})`);
console.log("PASS welcome no longer lists the replaced host");
console.log("REPLACE_SMOKE_PASS");

second.ws.close();
process.exit(0);
