#!/usr/bin/env node

/**
 * Cross-machine test helper: host the fake TUI under a PTY and stream output.
 *
 * Required environment:
 *   TOKIMEKI_RELAY_URL, TOKIMEKI_MASTER_TOKEN, TOKIMEKI_SESSION,
 *   TOKIMEKI_SESSION_TOKEN
 *
 * Optional: TOKIMEKI_P2P (auto|off), TOKIMEKI_ICE_TRANSPORT_POLICY (all|relay),
 *           TOKIMEKI_LOG_LEVEL.
 *
 * This is a test harness, not part of the CLI. It prints HOST_READY once the
 * fake TUI's initial screen is available, and HOST_EXIT=<code> on exit.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pty from "@homebridge/node-pty-prebuilt-multiarch";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(root, "packages/cli/dist/index.js");
const fakeTui = join(root, "scripts/e2e/fake-tui.mjs");

for (const name of ["TOKIMEKI_RELAY_URL", "TOKIMEKI_MASTER_TOKEN", "TOKIMEKI_SESSION"]) {
  if (!process.env[name]) {
    console.error(`HOST_FAIL: ${name} is required`);
    process.exit(2);
  }
}

const child = pty.spawn(process.execPath, [cli, "run", "--", process.execPath, fakeTui], {
  name: "tokimeki-host",
  cwd: root,
  cols: 90,
  rows: 28,
  env: {
    ...process.env,
    TOKIMEKI_TERM: "xterm-256color",
    TOKIMEKI_COLORTERM: "truecolor",
    TOKIMEKI_HEARTBEAT_SECONDS: "10",
    TOKIMEKI_SCROLLBACK_LINES: "1000",
    TOKIMEKI_SNAPSHOT_MAX_BYTES: "262144",
    TOKIMEKI_LOG_LEVEL: process.env.TOKIMEKI_LOG_LEVEL ?? "debug",
  },
  encoding: null,
});

let output = "";
let ready = false;
child.onData((data) => {
  const text = Buffer.from(data).toString("utf8");
  output += text;
  process.stdout.write(text);
  if (!ready && output.includes("TOKIMEKI_E2E_READY")) {
    ready = true;
    process.stdout.write("\nHOST_READY\n");
  }
});

child.onExit(({ exitCode, signal }) => {
  process.stdout.write(`\nHOST_EXIT=${exitCode} SIGNAL=${signal}\n`);
  process.exit(exitCode === 0 ? 0 : 1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    try {
      child.kill();
    } catch {
      // best effort
    }
  });
}
