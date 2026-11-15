import { randomBytes } from "node:crypto";

import { RelayHost } from "../harness/relay-host.mjs";
import { ensureRemoteHarness, spawnRemoteViewer } from "./ssh.mjs";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * WAN snapshot + reconnect probe.
 *
 * The local synthetic host sends a 256 KiB targeted snapshot, the remote
 * viewer drops its socket, waits `reconnectMs`, reconnects with a new client
 * id, sends `resync`, and waits for the targeted snapshot the host answers
 * automatically. The remote viewer reports both delivery latencies; the host
 * stays local so the session token never leaves the SSH stdin pipe.
 */
export async function runCrossNatSnapshot({
  relayUrl,
  masterToken,
  remote,
  snapshotBytes = 256 * 1024,
  reconnectMs = 2_000,
  timeoutMs = 120_000,
}) {
  await ensureRemoteHarness(remote);

  const session = `perf-xnat-snap-${remote}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionToken = randomBytes(32).toString("base64url");
  const clientId = "perf-snapshot-viewer";
  const host = new RelayHost({
    relayUrl,
    session,
    masterToken,
    sessionToken,
    clientId: "perf-host",
    resyncPayloadBytes: snapshotBytes,
  });
  let remoteViewer = null;

  try {
    await host.connect();
    const args = [
      `--relay ${shellQuote(relayUrl)}`,
      `--session ${shellQuote(session)}`,
      `--client-id ${shellQuote(clientId)}`,
      "--snapshot-reconnect",
      `--reconnect-ms ${shellQuote(reconnectMs)}`,
      `--timeout-ms ${shellQuote(timeoutMs)}`,
    ].join(" ");
    remoteViewer = spawnRemoteViewer({
      remote,
      args,
      token: sessionToken,
      timeoutMs: timeoutMs + 30_000,
    });
    await remoteViewer.ready;
    await host.waitForViewerCount(1, 30_000);
    const joined = await host.waitForControl(
      "peer-joined",
      (message) => typeof message.clientId === "string",
      30_000,
    );
    const targetId = joined.clientId;

    host.sendSnapshot({
      targetId,
      payload: Buffer.alloc(snapshotBytes, 0x41),
    });

    let resultTimer = null;
    let done;
    try {
      done = await Promise.race([
        remoteViewer.done,
        new Promise((_, reject) => {
          resultTimer = setTimeout(
            () => reject(new Error("remote viewer snapshot result timeout")),
            timeoutMs + 20_000,
          );
        }),
      ]);
    } finally {
      // The timer only guards this race; leaving it pending would keep the
      // CLI process alive for up to timeoutMs + 20s after a successful run.
      if (resultTimer !== null) {
        clearTimeout(resultTimer);
      }
    }
    const resultMatch = done.stdout.match(/REMOTE_VIEWER_RESULT (.+)/);
    const failMatch = done.stdout.match(/REMOTE_VIEWER_FAIL (.+)/);
    if (resultMatch === null) {
      throw new Error(
        failMatch?.[1]?.trim() ??
          `remote snapshot viewer exited ${done.code} (stderr=${done.stderr.slice(-500)})`,
      );
    }
    const result = JSON.parse(resultMatch[1]);
    return {
      session,
      remote,
      snapshotBytes,
      reconnectMs,
      targetId,
      hostErrors: [...host.errors],
      hostErrorMessages: host.controls
        .filter((message) => message.type === "error")
        .map((message) => message.code ?? message.message ?? "error"),
      result,
      stderr: done.stderr.slice(-1000),
    };
  } finally {
    await host.close();
    remoteViewer?.close();
  }
}
