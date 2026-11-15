#!/usr/bin/env node
/**
 * Low-level relay protocol smoke test (no PTY, no CLI).
 *
 * Validates handshake/auth, peer notifications, OUTPUT broadcast, targeted
 * SNAPSHOT_TO, and rejection of a bad session token against a running relay.
 *
 *   TOKIMEKI_RELAY_URL=ws://127.0.0.1:8787 TOKIMEKI_MASTER_TOKEN=... node scripts/e2e/relay-smoke.mjs
 */

import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";

const relayUrl = process.env.TOKIMEKI_RELAY_URL ?? "ws://127.0.0.1:8787";
const masterToken = process.env.TOKIMEKI_MASTER_TOKEN;
const session = process.env.TOKIMEKI_SESSION ?? `smoke-${Date.now()}`;
const sessionToken = process.env.TOKIMEKI_SESSION_TOKEN ?? randomBytes(32).toString("base64url");

if (!masterToken) {
  console.error("TOKIMEKI_MASTER_TOKEN is required");
  process.exit(2);
}

const base = relayUrl.replace(/^http/, "ws").replace(/\/$/, "");
const url = `${base}/ws/${encodeURIComponent(session)}`;

function connect(headers) {
  return new WebSocket(url, { headers });
}

function waitOpen(ws, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: open timeout`)), 10_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function nextJson(ws, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: message timeout`)), 10_000);
    const onMessage = (data, isBinary) => {
      if (isBinary) return;
      let parsed;
      try {
        parsed = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(parsed);
    };
    ws.on("message", onMessage);
  });
}

function nextBinary(ws, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: binary timeout`)), 10_000);
    const onMessage = (data, isBinary) => {
      if (!isBinary) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(Buffer.from(data));
    };
    ws.on("message", onMessage);
  });
}

function send(ws, message) {
  ws.send(JSON.stringify({ v: 1, ...message }));
}

function outputFrame(seq, text) {
  const payload = Buffer.from(text, "utf8");
  const frame = Buffer.alloc(9 + payload.length);
  frame[0] = 0x02;
  frame.writeBigUInt64BE(BigInt(seq), 1);
  payload.copy(frame, 9);
  return frame;
}

function snapshotToFrame(targetId, seq, text) {
  const target = Buffer.from(targetId, "utf8");
  const payload = Buffer.from(text, "utf8");
  const frame = Buffer.alloc(1 + 1 + target.length + 8 + payload.length);
  frame[0] = 0x05;
  frame[1] = target.length;
  target.copy(frame, 2);
  frame.writeBigUInt64BE(BigInt(seq), 2 + target.length);
  payload.copy(frame, 2 + target.length + 8);
  return frame;
}

function decodeOutput(bytes) {
  return {
    type: bytes[0],
    seq: Number(bytes.readBigUInt64BE(1)),
    text: bytes.subarray(9).toString("utf8"),
  };
}

function decodeSnapshotTo(bytes) {
  const length = bytes[1];
  const targetId = bytes.subarray(2, 2 + length).toString("utf8");
  const seq = Number(bytes.readBigUInt64BE(2 + length));
  return { targetId, seq, text: bytes.subarray(2 + length + 8).toString("utf8") };
}

async function main() {
  console.log(`session=${session} relay=${relayUrl}`);

  // Bad viewer token is rejected after hello.
  const bad = connect({ "X-Tokimeki-Session": "definitely-wrong" });
  await waitOpen(bad, "bad-viewer");
  send(bad, {
    type: "hello",
    role: "viewer",
    session,
    clientId: "bad-viewer",
    capabilities: {},
    cols: 80,
    rows: 24,
  });
  const badReply = await nextJson(bad, "bad-viewer");
  if (
    badReply.type !== "error" ||
    (badReply.code !== "unauthorized" && badReply.code !== "invalid_session")
  ) {
    throw new Error(
      `bad token: expected unauthorized/invalid_session, got ${JSON.stringify(badReply)}`,
    );
  }
  console.log("PASS bad session token rejected");

  const host = connect({
    "X-Tokimeki-Master": masterToken,
    "X-Tokimeki-Session": sessionToken,
  });
  await waitOpen(host, "host");
  send(host, {
    type: "hello",
    role: "host",
    session,
    clientId: "host-smoke",
    capabilities: {},
    cols: 90,
    rows: 30,
  });
  const hostWelcome = await nextJson(host, "host welcome");
  if (hostWelcome.type !== "welcome" || hostWelcome.hostOnline !== true) {
    throw new Error(`host welcome: ${JSON.stringify(hostWelcome)}`);
  }
  console.log(`PASS host welcome (ice=${hostWelcome.iceProvider})`);

  // Install the host collector before the viewer connects: the relay sends the
  // viewer's resize/peer-joined notifications immediately after its welcome.
  const hostMessages = [];
  const collect = (data, isBinary) => {
    if (!isBinary) hostMessages.push(JSON.parse(data.toString("utf8")));
  };
  host.on("message", collect);

  const viewer = connect({ "X-Tokimeki-Session": sessionToken });
  await waitOpen(viewer, "viewer");
  send(viewer, {
    type: "hello",
    role: "viewer",
    session,
    clientId: "viewer-smoke",
    capabilities: {},
    cols: 100,
    rows: 30,
  });
  const viewerWelcome = await nextJson(viewer, "viewer welcome");
  if (viewerWelcome.type !== "welcome" || viewerWelcome.hostOnline !== true) {
    throw new Error(`viewer welcome: ${JSON.stringify(viewerWelcome)}`);
  }
  console.log("PASS viewer welcome");

  const deadline = Date.now() + 5_000;
  let sawResize = false;
  let sawJoin = false;
  while (Date.now() < deadline && (!sawResize || !sawJoin)) {
    sawResize = hostMessages.some(
      (m) => m.type === "resize" && m.clientId === "viewer-smoke" && m.cols === 100,
    );
    sawJoin = hostMessages.some((m) => m.type === "peer-joined" && m.clientId === "viewer-smoke");
    if (!sawResize || !sawJoin) await new Promise((r) => setTimeout(r, 25));
  }
  host.off("message", collect);
  if (!sawResize || !sawJoin) {
    throw new Error(`host did not get resize+peer-joined: ${JSON.stringify(hostMessages)}`);
  }
  console.log("PASS resize + peer-joined delivered to host");

  host.send(outputFrame(0, "live-output"));
  const output = decodeOutput(await nextBinary(viewer, "viewer output"));
  if (output.type !== 0x02 || output.seq !== 0 || output.text !== "live-output") {
    throw new Error(`unexpected output: ${JSON.stringify(output)}`);
  }
  console.log("PASS OUTPUT broadcast");

  host.send(snapshotToFrame("viewer-smoke", 1, "SNAPSHOT-CONTENT"));
  const snapshot = decodeSnapshotTo(await nextBinary(viewer, "viewer snapshot"));
  if (
    snapshot.targetId !== "viewer-smoke" ||
    snapshot.seq !== 1 ||
    snapshot.text !== "SNAPSHOT-CONTENT"
  ) {
    throw new Error(`unexpected snapshot: ${JSON.stringify(snapshot)}`);
  }
  console.log("PASS SNAPSHOT_TO targeted delivery");

  // Ping/pong.
  send(viewer, { type: "ping", ts: 123 });
  const pong = await nextJson(viewer, "viewer pong");
  if (pong.type !== "pong" || pong.ts !== 123) {
    throw new Error(`unexpected pong: ${JSON.stringify(pong)}`);
  }
  console.log("PASS application ping/pong");

  host.close();
  viewer.close();
  bad.close();
  console.log("RELAY SMOKE PASS");
}

main().catch((error) => {
  console.error(`RELAY SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
