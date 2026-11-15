#!/usr/bin/env node
/**
 * Deterministic TUI fixture for tokimeki end-to-end tests.
 *
 * It exercises the terminal features the relay must preserve:
 * alternate screen, colors, cursor movement, mouse/paste/focus modes,
 * resize handling, raw input echo, and Ctrl-C shutdown.
 *
 * Markers are intentionally stable so test harnesses can assert on them.
 */

const ESC = "\x1b";
const stdout = process.stdout;
const stdin = process.stdin;
let cleanedUp = false;
let inputCount = 0;
let lastInput = "-";

// Values are never printed: the e2e test only asserts that these names are
// absent from the PTY child environment.
const SECRET_ENV_VARS = [
  "TOKIMEKI_MASTER_TOKEN",
  "TOKIMEKI_SESSION_TOKEN",
  "TOKIMEKI_TUNNEL_SECRET",
  "TOKIMEKI_COTURN_SECRET",
  "TOKIMEKI_TURN_API_TOKEN",
  "TOKIMEKI_TURN_CREDENTIAL",
];
const BURST_TOTAL_BYTES = 4 * 1024 * 1024;
const BURST_LINE = `${"0123456789abcdef".repeat(5)}\r\n`;
const BURST_CHUNK = BURST_LINE.repeat(100);
let bursting = false;

function write(value) {
  stdout.write(value);
}

function writeAsync(value) {
  return new Promise((resolve) => {
    if (stdout.write(value)) {
      resolve();
      return;
    }
    stdout.once("drain", resolve);
  });
}

function envCheck() {
  const leaked = SECRET_ENV_VARS.filter((name) => {
    const value = process.env[name];
    return value !== undefined && value !== "";
  });
  write(`ENV_SECRETS_PRESENT=${leaked.length}\r\n`);
  write(`ENV_SECRET_NAMES=${leaked.length === 0 ? "none" : leaked.join(",")}\r\n`);
  write(`ENV_RELAY_URL_PRESENT=${process.env.TOKIMEKI_RELAY_URL ? "yes" : "no"}\r\n`);
  write("TOKIMEKI_ENV_CHECK_DONE\r\n");
}

async function burst(totalBytes) {
  if (bursting) return;
  bursting = true;
  try {
    write(`\r\nBURST_START=${totalBytes}\r\n`);
    let sent = 0;
    while (sent < totalBytes) {
      const remaining = totalBytes - sent;
      const part =
        remaining >= BURST_CHUNK.length
          ? BURST_CHUNK
          : BURST_LINE.repeat(Math.ceil(remaining / BURST_LINE.length)).slice(0, remaining);
      await writeAsync(part);
      sent += Buffer.byteLength(part);
    }
    write(`\r\nBURST_DONE=${sent}\r\n`);
  } catch (error) {
    write(`\r\nBURST_ERROR=${error instanceof Error ? error.message : String(error)}\r\n`);
  } finally {
    bursting = false;
  }
}

function frame(reason) {
  const cols = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;
  write(`${ESC}[2J${ESC}[H`);
  write(`${ESC}[1;36mtokimeki fake TUI${ESC}[0m\r\n`);
  write(`REASON=${reason}\r\n`);
  write(`SIZE=${cols}x${rows}\r\n`);
  // State that survives screen clears, so a reconnect snapshot can prove it
  // restored content produced before the previous client disconnected.
  write(`INPUTS=${inputCount}\r\n`);
  write(`LAST_INPUT=${lastInput}\r\n`);
  write("TOKIMEKI_E2E_READY\r\n");
  write("Type text to echo it; Ctrl-C exits.\r\n");
  write(`${ESC}[?25h`);
}

function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  write(
    `${ESC}[?1000l${ESC}[?1002l${ESC}[?1003l${ESC}[?1006l` +
      `${ESC}[?2004l${ESC}[?1004l${ESC}[?2026l${ESC}[?25h${ESC}[0m${ESC}[?1049l`,
  );
}

function enableModes() {
  write(`${ESC}[?1049h${ESC}[?1000h${ESC}[?1006h${ESC}[?2004h${ESC}[?1004h`);
  write(`${ESC}[?25l`);
}

let ctrlCPending = false;
function ctrlC() {
  if (ctrlCPending) return;
  ctrlCPending = true;
  write("\r\nTOKIMEKI_E2E_CTRL_C\r\n");
  cleanup();
  // ConPTY can drop output written immediately before exit. Keep the PTY
  // alive briefly so the host drains the marker before onExit.
  setTimeout(() => process.exit(0), 200);
}

process.on("exit", cleanup);
// ConPTY may translate Ctrl-C into SIGINT instead of delivering 0x03 on stdin.
// Both paths must emit the marker so live e2e can assert propagation on Windows
// and Unix alike.
process.on("SIGINT", ctrlC);
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

if (stdin.isTTY) {
  stdin.setRawMode(true);
}
stdin.resume();
stdin.on("data", (data) => {
  const text = data.toString("utf8");
  if (text.includes("\u0003")) {
    ctrlC();
  }
  if (text === "q") {
    write("\r\nTOKIMEKI_E2E_QUIT\r\n");
    cleanup();
    process.exit(0);
  }
  if (text.includes("env-check")) envCheck();
  if (text.includes("burst-e2e")) void burst(BURST_TOTAL_BYTES);
  if (text.includes("redraw-e2e")) frame("redraw");
  // Echo each printable chunk so attach-side tests can prove bidirectional flow.
  const escaped = text.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  inputCount += 1;
  lastInput = escaped.replace(/[^\x20-\x7e]/g, "?").slice(0, 40);
  write(`ECHO:${escaped}\r\n`);
  write(`INPUTS=${inputCount} LAST_INPUT=${lastInput}\r\n`);
});

process.on("SIGWINCH", () => {
  frame("resize");
});
// SIGWINCH is not reliably delivered on Windows; node-pty/ConPTY updates the
// stdout dimensions and emits 'resize' on the stream instead.
stdout.on("resize", () => {
  frame("resize");
});

enableModes();
frame("start");

// Prove the session stays alive and the snapshot path can restore live content.
const timer = setInterval(() => {
  write(`TICK=${Date.now()}\r\n`);
}, 1500);
timer.unref?.();
