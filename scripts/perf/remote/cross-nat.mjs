import { randomBytes } from "node:crypto";
import { nsToMs } from "../harness/metrics.mjs";
import { RelayHost } from "../harness/relay-host.mjs";
import { ensureRemoteHarness, spawnRemoteViewer } from "./ssh.mjs";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Relay-only cross-NAT throughput: local synthetic host + remote synthetic
 * viewers on a public VPS. The session token is sent over SSH stdin; the
 * master token stays local.
 */
export async function runCrossNatRelay({
  relayUrl,
  masterToken,
  remote,
  viewers = 1,
  bytes = 8 * 1024 * 1024,
  frameBytes = 64 * 1024,
  timeoutMs = 120_000,
  flow = false,
  stallAfter = 0,
  stallMs = 0,
}) {
  await ensureRemoteHarness(remote);

  const effectiveFrameBytes = flow ? 16 * 1024 : frameBytes;
  const session = `perf-xnat-${remote}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionToken = randomBytes(32).toString("base64url");
  const host = new RelayHost({
    relayUrl,
    session,
    masterToken,
    sessionToken,
    clientId: "perf-host",
  });
  const remotes = [];

  try {
    await host.connect();
    for (let index = 0; index < viewers; index += 1) {
      const clientId = `perf-xnat-viewer-${index + 1}`;
      const args = [
        `--relay ${shellQuote(relayUrl)}`,
        `--session ${shellQuote(session)}`,
        `--client-id ${shellQuote(clientId)}`,
        `--bytes ${shellQuote(bytes)}`,
        `--timeout-ms ${shellQuote(timeoutMs)}`,
        ...(flow
          ? [`--stall-after ${shellQuote(stallAfter)}`, `--stall-ms ${shellQuote(stallMs)}`]
          : []),
      ].join(" ");
      const remoteViewer = spawnRemoteViewer({
        remote,
        args,
        token: sessionToken,
        timeoutMs: timeoutMs + 30_000,
      });
      remotes.push({ clientId, ...remoteViewer });
    }

    await Promise.all(remotes.map((entry) => entry.ready));
    // Ensure the relay has notified the host about every viewer before the
    // burst starts; the viewer's welcome can arrive slightly before peer-joined.
    await host.waitForViewerCount(viewers, 20_000);

    let hostError = null;
    let send = null;
    let sendTimer = null;
    const pauseBefore = host.pauseEvents.length;
    const resumeBefore = host.resumeEvents.length;
    const sendTimeout = new Promise((_, reject) => {
      sendTimer = setTimeout(
        () => reject(new Error("host send timeout (relay paused without resume)")),
        timeoutMs,
      );
    });
    try {
      send = await Promise.race([
        host.sendOutput({
          frameBytes: effectiveFrameBytes,
          totalBytes: bytes,
          ...(flow
            ? {
                paceBytes: 64 * 1024,
                paceDelayMs: Math.max(100, Math.ceil(stallMs / 20)),
              }
            : {}),
        }),
        sendTimeout,
      ]);
    } catch (error) {
      hostError = error;
    } finally {
      if (sendTimer !== null) {
        clearTimeout(sendTimer);
      }
    }
    const hostDurationMs =
      send === null ? 0 : Math.max(1, nsToMs(send.finishedAt - send.startedAt));
    const pauseEvents = host.pauseEvents.slice(pauseBefore);
    const resumeEvents = host.resumeEvents.slice(resumeBefore);
    const firstPauseAt = pauseEvents[0]?.at;
    const firstResumeAt = resumeEvents[0]?.at;
    const sendStartedAt = send?.startedAt;
    const hostPauseAtMs =
      firstPauseAt !== undefined && sendStartedAt !== undefined
        ? nsToMs(firstPauseAt - sendStartedAt)
        : null;
    const hostResumeAtMs =
      firstResumeAt !== undefined && sendStartedAt !== undefined
        ? nsToMs(firstResumeAt - sendStartedAt)
        : null;

    const results = [];
    // The remote viewer keeps receiving buffered relay data after the host's
    // send loop finishes; do not cut it off with a short fixed window.
    const resultTimeoutMs = Math.min(timeoutMs + 10_000, 130_000);
    for (const entry of remotes) {
      let done;
      let resultTimer = null;
      try {
        done = await Promise.race([
          entry.done,
          new Promise((_, reject) => {
            resultTimer = setTimeout(
              () => reject(new Error("remote viewer result timeout")),
              resultTimeoutMs,
            );
          }),
        ]);
      } catch (error) {
        results.push({
          clientId: entry.clientId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          stderr: entry.stderr.slice(-1000),
        });
        entry.close();
        continue;
      } finally {
        // The timer only guards this race; leaving it pending would keep the
        // CLI process alive after a successful run.
        if (resultTimer !== null) {
          clearTimeout(resultTimer);
        }
      }
      const resultMatch = done.stdout.match(/REMOTE_VIEWER_RESULT (.+)/);
      const failMatch = done.stdout.match(/REMOTE_VIEWER_FAIL (.+)/);
      if (resultMatch === null) {
        results.push({
          clientId: entry.clientId,
          ok: false,
          exitCode: done.code,
          error: failMatch?.[1]?.trim() ?? `remote viewer exited ${done.code}`,
          stderr: done.stderr.slice(-1000),
        });
        continue;
      }
      const parsed = JSON.parse(resultMatch[1]);
      results.push({ ...parsed, exitCode: done.code, stderr: done.stderr.slice(-1000) });
    }

    return {
      session,
      remote,
      hostSentBytes: send?.sentBytes ?? 0,
      hostDurationMs: Math.round(hostDurationMs * 1000) / 1000,
      hostThroughputBytesPerSec:
        send === null ? 0 : Math.round(send.sentBytes / (hostDurationMs / 1000)),
      hostError: hostError === null ? null : hostError.message,
      flow: flow
        ? {
            stallAfter,
            stallMs,
            hostPauses: pauseEvents.length,
            hostResumes: resumeEvents.length,
            hostPauseAtMs: hostPauseAtMs === null ? null : Math.round(hostPauseAtMs * 1000) / 1000,
            hostResumeAtMs:
              hostResumeAtMs === null ? null : Math.round(hostResumeAtMs * 1000) / 1000,
            hostPauseWindowMs:
              hostPauseAtMs === null || hostResumeAtMs === null
                ? null
                : Math.round((hostResumeAtMs - hostPauseAtMs) * 1000) / 1000,
          }
        : null,
      viewers: results,
    };
  } finally {
    await host.close();
    for (const entry of remotes) {
      entry.close();
    }
  }
}
