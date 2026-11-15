#!/usr/bin/env node
/**
 * tokimeki v1 performance harness.
 *
 * Scenarios:
 *   smoke  - handshake + 1 MiB throughput + 20 echo RTTs + one snapshot (<1 min)
 *   local  - synthetic relay throughput for N viewers (one run)
 *
 * Requires a running relay:
 *   TOKIMEKI_RELAY_URL=ws://127.0.0.1:8787
 *   TOKIMEKI_MASTER_TOKEN=<development master token>
 *
 * No token is ever printed or written to the result JSON.
 */

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  collectEnvironment,
  nowNs,
  nsToMs,
  sampleNamedProcessRss,
  sampleRssBytes,
  sleep,
  summarizeLatency,
  timestampId,
} from "./harness/metrics.mjs";
import { runRealP2P } from "./harness/real-cli.mjs";
import { RelayHost } from "./harness/relay-host.mjs";
import { RelayViewer } from "./harness/relay-viewer.mjs";
import {
  compareResults,
  loadResult,
  printComparison,
  printSummary,
  RESULT_SCHEMA_VERSION,
  writeResult,
} from "./harness/report.mjs";
import { runCrossNatRelay } from "./remote/cross-nat.mjs";
import { runCrossNatCli } from "./remote/cross-nat-cli.mjs";
import { runCrossNatSnapshot } from "./remote/cross-nat-snapshot.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const defaultOutDir = resolve(root, "scripts/perf/results");

const USAGE = `Usage:
  node scripts/perf/cli.mjs --scenario smoke [options]
  node scripts/perf/cli.mjs --scenario local --viewers <n> [options]
  node scripts/perf/cli.mjs --scenario matrix [options]
  node scripts/perf/cli.mjs --scenario latency --viewers <n> [options]
  node scripts/perf/cli.mjs --scenario flow
  node scripts/perf/cli.mjs --scenario snapshot
  node scripts/perf/cli.mjs --scenario soak [--viewers 2 --duration-minutes 60]
  node scripts/perf/cli.mjs --scenario p2p [--bytes 8388608]
  node scripts/perf/cli.mjs --scenario cross-nat --remote jp --mode relay \
    --viewers 1 --bytes 8388608
  node scripts/perf/cli.mjs --scenario cross-nat --remote jp --mode relay-flow \
    --bytes 4194304 --stall-after 1048576 --stall-ms 2000
  node scripts/perf/cli.mjs --scenario cross-nat-snapshot --remote jp \
    --snapshot-bytes 262144 --reconnect-ms 2000
  node scripts/perf/cli.mjs --compare <baseline.json> <current.json>

Options:
  --scenario <smoke|local|matrix|latency|flow|snapshot|soak|p2p|cross-nat|cross-nat-snapshot>  Scenario (default: smoke)
  --env <local|production>   Environment label (default: local)
  --viewers <n>              Viewer count; matrix defaults to 1/2/4/8
  --frame-bytes <n>          OUTPUT payload bytes per frame; matrix defaults to 1 KiB/64 KiB
  --total-bytes <n>          Payload bytes per throughput case
  --repetitions <n>          Matrix repetitions (default: 3)
  --warmup-ms <n>            Warmup (reserved)
  --echoes <n>               Latency echo count (default: 1000)
  --interval-ms <n>          Delay between latency echoes (default: 20)
  --duration-minutes <n>     Soak duration in minutes (default: 60)
  --burst-bytes <n>          Soak burst payload bytes (default: 1 MiB)
  --burst-interval-ms <n>    Idle time between soak bursts (default: 5000)
  --sample-interval-ms <n>   Soak resource sample interval (default: 600000)
  --bytes <n>                Real-CLI P2P burst bytes (default: 8 MiB)
  --rtt-samples <n>          Real-CLI P2P RTT samples (default: 20)
  --remote <jp|us>           cross-NAT remote viewer host (default: jp)
  --mode <relay|relay-flow|p2p-direct|p2p-turn|p2p-fallback>  cross-NAT mode
  --stall-after <bytes>      relay-flow: stop ACKing after this many bytes
  --stall-ms <n>             relay-flow: resume ACKing after this delay
  --snapshot-bytes <n>       cross-nat snapshot payload bytes (default: 262144)
  --reconnect-ms <n>         cross-nat snapshot reconnect delay (default: 2000)
  --timeout-ms <n>           cross-NAT remote timeout (default: 120000)
  --out <path>               Result JSON path
  --max-bytes <n>            Required for production runs
  --max-duration <seconds>   Required for production runs
  --help                     Show this help

Environment:
  TOKIMEKI_RELAY_URL         Relay base URL (default ws://127.0.0.1:8787)
  TOKIMEKI_MASTER_TOKEN      Required host master token
  TOKIMEKI_SESSION           Optional session name
  TOKIMEKI_SESSION_TOKEN     Optional session token

Exit codes: 0 pass, 1 assertion/threshold failure, 2 usage/environment, 3 relay unreachable.
Tokens are never printed or persisted.`;

function parsePositiveInteger(name, raw, fallback) {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError(`${name} must be a positive integer`);
  }
  return value;
}

class UsageError extends Error {}

function parseNonNegativeInteger(name, raw, fallback) {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new UsageError(`${name} must be a non-negative integer`);
  }
  return value;
}

function parsePositiveNumber(name, raw, fallback) {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError(`${name} must be a positive number`);
  }
  return value;
}

function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      scenario: { type: "string", default: "smoke" },
      env: { type: "string", default: "local" },
      viewers: { type: "string" },
      "frame-bytes": { type: "string" },
      "total-bytes": { type: "string" },
      repetitions: { type: "string" },
      "warmup-ms": { type: "string" },
      echoes: { type: "string" },
      "interval-ms": { type: "string" },
      "duration-minutes": { type: "string" },
      "burst-bytes": { type: "string" },
      "burst-interval-ms": { type: "string" },
      "sample-interval-ms": { type: "string" },
      bytes: { type: "string" },
      "rtt-samples": { type: "string" },
      remote: { type: "string", default: "jp" },
      mode: { type: "string", default: "relay" },
      "stall-after": { type: "string" },
      "stall-ms": { type: "string" },
      "snapshot-bytes": { type: "string" },
      "reconnect-ms": { type: "string" },
      "timeout-ms": { type: "string" },
      out: { type: "string" },
      "max-bytes": { type: "string" },
      "max-duration": { type: "string" },
      compare: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  return { values, positionals };
}

function resolveRelayUrl() {
  const raw = process.env.TOKIMEKI_RELAY_URL ?? "ws://127.0.0.1:8787";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError("TOKIMEKI_RELAY_URL is not a valid URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new UsageError("TOKIMEKI_RELAY_URL must use ws:// or wss://");
  }
  return raw.replace(/\/+$/, "");
}

function isLoopbackRelay(relayUrl) {
  const host = new URL(relayUrl).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

function relayEnvironmentLabel(relayUrl) {
  return isLoopbackRelay(relayUrl) ? "local-loopback" : "remote-relay";
}

function isConnectionError(error) {
  const code = error?.code;
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT";
}

function newSession(prefix) {
  return process.env.TOKIMEKI_SESSION ?? `perf-${prefix}-${Date.now()}`;
}

function newSessionToken() {
  return process.env.TOKIMEKI_SESSION_TOKEN ?? randomBytes(32).toString("base64url");
}

function baseResult({ scenario, relayUrl, config, environment }) {
  const env = collectEnvironment({ relayUrl, environment });
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    run: {
      id: `${timestampId()}-${scenario}`,
      startedAt: new Date().toISOString(),
      ...env,
    },
    config,
    results: [],
    resources: {
      peakRssBytes: sampleRssBytes(),
      endRssBytes: 0,
      peakCpuPercent: 0,
    },
    notes: [],
  };
}

async function runSmoke({ relayUrl, masterToken, outPath, environment }) {
  const startedAt = new Date();
  const totalBytes = 1024 * 1024;
  const frameBytes = 1024;
  const echoCount = 20;
  const session = newSession("smoke");
  const sessionToken = newSessionToken();
  const result = baseResult({
    scenario: "smoke",
    relayUrl,
    environment,
    config: {
      scenario: "smoke",
      viewers: 1,
      frameBytes,
      totalBytes,
      echoCount,
      repetitions: 1,
      warmupMs: 0,
    },
  });
  result.run.startedAt = startedAt.toISOString();
  result.resources.peakRssBytes = sampleRssBytes();

  const host = new RelayHost({
    relayUrl,
    session,
    masterToken,
    sessionToken,
    clientId: "perf-host",
  });
  const viewer = new RelayViewer({
    relayUrl,
    session,
    sessionToken,
    clientId: "perf-viewer-1",
  });

  let connected = false;
  try {
    await host.connect();
    connected = true;
    await viewer.connect();
    await host.waitForViewerCount(1);

    const send = await host.sendOutput({ frameBytes, totalBytes });
    await viewer.waitForBytes(totalBytes, 30_000);

    for (let index = 0; index < echoCount; index += 1) {
      viewer.sendInput({ paddingBytes: 32 });
    }
    await viewer.waitForLatencySamples(echoCount, 15_000);

    const snapshotPayload = Buffer.alloc(4096, 0x41);
    const snapshotSentAt = nowNs();
    host.sendSnapshot({ targetId: viewer.clientId, payload: snapshotPayload });
    const snapshot = await viewer.waitForSnapshot(10_000);

    const throughputDurationMs = Math.max(1, nsToMs(send.finishedAt - send.startedAt));
    const throughputBytesPerSec = send.sentBytes / (throughputDurationMs / 1000);
    const snapshotLatencyMs = nsToMs(snapshot.at - snapshotSentAt);
    const errors = [...host.errors, ...viewer.errors];
    result.results.push({
      case: "smoke/throughput-1KiB",
      repeat: 1,
      payloadBytes: send.sentBytes,
      wireBytes: viewer.receivedWireBytes,
      durationMs: Math.round(throughputDurationMs * 1000) / 1000,
      throughputBytesPerSec: Math.round(throughputBytesPerSec),
      perViewerBytesPerSec: [Math.round(throughputBytesPerSec)],
      latencyMs: summarizeLatency(viewer.latencySamplesMs),
      flowControl: {
        pauses: send.pauses,
        resumes: send.resumes,
        pauseLatencyMs: [],
        resumeLatencyMs: [],
      },
      errors,
    });
    result.results.push({
      case: "smoke/snapshot-4KiB",
      repeat: 1,
      payloadBytes: snapshot.bytes,
      wireBytes: 0,
      durationMs: Math.round(snapshotLatencyMs * 1000) / 1000,
      throughputBytesPerSec: 0,
      perViewerBytesPerSec: [],
      latencyMs: summarizeLatency([snapshotLatencyMs]),
      flowControl: { pauses: 0, resumes: 0, pauseLatencyMs: [], resumeLatencyMs: [] },
      errors: [],
    });
    result.resources.endRssBytes = sampleRssBytes();
    result.resources.peakRssBytes = Math.max(
      result.resources.peakRssBytes,
      result.resources.endRssBytes,
    );
    result.notes.push("smoke: small synthetic run for wiring/self-check, not a baseline");

    const failures = [];
    if (viewer.receivedPayloadBytes < totalBytes) {
      failures.push(`received ${viewer.receivedPayloadBytes}/${totalBytes} bytes`);
    }
    if (viewer.latencySamplesMs.length < echoCount) {
      failures.push(`latency samples ${viewer.latencySamplesMs.length}/${echoCount}`);
    }
    if (errors.length > 0) {
      failures.push(`${errors.length} socket/protocol errors`);
    }
    if (failures.length > 0) {
      result.notes.push(`smoke assertions failed: ${failures.join("; ")}`);
    }

    writeResult(outPath, result);
    printSummary(result);
    return failures.length === 0 ? 0 : 1;
  } catch (error) {
    result.notes.push(`smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    result.notes.push(...host.errors, ...viewer.errors);
    writeResult(outPath, result);
    printSummary(result);
    if (!connected && isConnectionError(error)) {
      console.error(`relay unreachable at ${relayUrl}: ${error.message}`);
      return 3;
    }
    return 1;
  } finally {
    await host.close();
    await viewer.close();
  }
}

async function runLocal({ relayUrl, masterToken, outPath, environment, options, limits = null }) {
  const viewers = options.viewers;
  const frameBytes = options.frameBytes;
  const totalBytes = options.totalBytes;
  if (limits !== null && totalBytes * viewers > limits.maxBytes) {
    throw new UsageError(
      `local run wire budget ${totalBytes * viewers} exceeds --max-bytes ${limits.maxBytes}`,
    );
  }
  const session = newSession("local");
  const sessionToken = newSessionToken();
  const result = baseResult({
    scenario: "local",
    relayUrl,
    environment,
    config: {
      scenario: "local",
      viewers,
      frameBytes,
      totalBytes,
      repetitions: 1,
      warmupMs: options.warmupMs,
    },
  });
  result.resources.peakRssBytes = sampleRssBytes();

  const host = new RelayHost({
    relayUrl,
    session,
    masterToken,
    sessionToken,
    clientId: "perf-host",
  });
  const viewerClients = Array.from({ length: viewers }, (_, index) => {
    return new RelayViewer({
      relayUrl,
      session,
      sessionToken,
      clientId: `perf-viewer-${index + 1}`,
    });
  });

  let connected = false;
  try {
    await host.connect();
    connected = true;
    for (const viewer of viewerClients) {
      await viewer.connect();
    }
    await host.waitForViewerCount(viewers);

    const before = viewerClients.map((viewer) => viewer.receivedPayloadBytes);
    const send = await host.sendOutput({ frameBytes, totalBytes });
    await Promise.all(
      viewerClients.map(async (viewer, index) => {
        try {
          await viewer.waitForBytes(before[index] + totalBytes, 5_000);
        } catch {
          // Flow control can drop frames during a full-speed burst.
        }
      }),
    );
    let lastDelivered = -1;
    for (let settle = 0; settle < 20; settle += 1) {
      const delivered = viewerClients.reduce(
        (total, viewer) => total + viewer.stats().receivedPayloadBytes,
        0,
      );
      if (delivered === lastDelivered) {
        break;
      }
      lastDelivered = delivered;
      await sleep(100);
    }

    const perViewerBytes = viewerClients.map(
      (viewer, index) => viewer.receivedPayloadBytes - before[index],
    );
    const deliveredBytes = perViewerBytes.reduce((total, value) => total + value, 0);
    const durationMs = Math.max(1, nsToMs(send.finishedAt - send.startedAt));
    const aggregateThroughput = deliveredBytes / (durationMs / 1000);
    const errors = [...host.errors, ...viewerClients.flatMap((viewer) => viewer.errors)];
    result.results.push({
      case: `local/throughput-${viewers}viewer-${frameBytes}B`,
      repeat: 1,
      payloadBytes: send.sentBytes,
      deliveredBytes,
      wireBytes: viewerClients.reduce((total, viewer) => total + viewer.receivedWireBytes, 0),
      durationMs: Math.round(durationMs * 1000) / 1000,
      throughputBytesPerSec: Math.round(aggregateThroughput),
      perViewerBytesPerSec: perViewerBytes.map((bytes) => Math.round(bytes / (durationMs / 1000))),
      latencyMs: summarizeLatency(viewerClients.flatMap((viewer) => viewer.latencySamplesMs)),
      flowControl: {
        pauses: send.pauses,
        resumes: send.resumes,
        pauseLatencyMs: [],
        resumeLatencyMs: [],
      },
      errors,
    });
    result.resources.endRssBytes = sampleRssBytes();
    result.resources.peakRssBytes = Math.max(
      result.resources.peakRssBytes,
      result.resources.endRssBytes,
    );
    result.notes.push(
      "local: synthetic relay run; one repetition in this build (matrix/repeats expand in Phase 2)",
    );
    if (deliveredBytes < totalBytes * viewers) {
      result.notes.push(
        `local: delivered ${deliveredBytes}/${totalBytes * viewers} bytes (flow-control drops)`,
      );
    }

    const failures = [];
    if (errors.length > 0) {
      failures.push(`${errors.length} socket/protocol errors`);
    }
    if (failures.length > 0) {
      result.notes.push(`local assertions failed: ${failures.join("; ")}`);
    }

    writeResult(outPath, result);
    printSummary(result);
    return failures.length === 0 ? 0 : 1;
  } catch (error) {
    result.notes.push(`local failed: ${error instanceof Error ? error.message : String(error)}`);
    result.notes.push(...host.errors, ...viewerClients.flatMap((viewer) => viewer.errors));
    writeResult(outPath, result);
    printSummary(result);
    if (!connected && isConnectionError(error)) {
      console.error(`relay unreachable at ${relayUrl}: ${error.message}`);
      return 3;
    }
    return 1;
  } finally {
    await host.close();
    await Promise.all(viewerClients.map((viewer) => viewer.close()));
  }
}

async function connectSession({ relayUrl, masterToken, prefix, viewers, resyncPayloadBytes = 64 }) {
  const session = `perf-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionToken = newSessionToken();
  const host = new RelayHost({
    relayUrl,
    session,
    masterToken,
    sessionToken,
    clientId: "perf-host",
    resyncPayloadBytes,
  });
  const viewerClients = Array.from({ length: viewers }, (_, index) => {
    return new RelayViewer({
      relayUrl,
      session,
      sessionToken,
      clientId: `perf-viewer-${index + 1}`,
    });
  });
  await host.connect();
  for (const viewer of viewerClients) {
    await viewer.connect();
  }
  await host.waitForViewerCount(viewers);
  return { host, viewers: viewerClients, session, sessionToken };
}

async function closeSession(host, viewerClients) {
  await host.close();
  await Promise.all(viewerClients.map((viewer) => viewer.close()));
}

async function runMatrix({ relayUrl, masterToken, outPath, environment, options, limits = null }) {
  const repetitions = options.repetitions;
  const frameSizes = options.frameBytesList;
  const viewerCounts = options.viewersList;
  const result = baseResult({
    scenario: "matrix",
    relayUrl,
    environment,
    config: {
      scenario: "matrix",
      viewers: viewerCounts.join(","),
      frameBytes: frameSizes.join(","),
      totalBytes: options.totalBytes ?? "per-frame-default",
      repetitions,
      warmupMs: options.warmupMs,
    },
  });
  result.resources.peakRssBytes = sampleRssBytes();
  let failures = 0;

  for (const frameBytes of frameSizes) {
    for (const viewers of viewerCounts) {
      const totalBytes =
        options.totalBytes ?? (frameBytes >= 65536 ? 256 * 1024 * 1024 : 64 * 1024 * 1024);
      const caseName = `matrix/${viewers}viewer-${frameBytes}B`;
      if (limits !== null && totalBytes * viewers > limits.maxBytes) {
        throw new UsageError(
          `${caseName} wire budget ${totalBytes * viewers} exceeds --max-bytes ${limits.maxBytes}`,
        );
      }
      let host = null;
      let viewerClients = [];
      try {
        const connected = await connectSession({
          relayUrl,
          masterToken,
          prefix: `matrix-${viewers}-${frameBytes}`,
          viewers,
        });
        host = connected.host;
        viewerClients = connected.viewers;

        const paceBytes = frameBytes <= 1024 ? 512 * 1024 : 0;
        const paceDelayMs = frameBytes <= 1024 ? 5 : 0;
        const warmupBytes = Math.min(totalBytes, Math.max(1024, Math.floor(totalBytes * 0.1)));
        await host.sendOutput({
          frameBytes,
          totalBytes: warmupBytes,
          paceBytes,
          paceDelayMs,
        });
        await Promise.all(viewerClients.map((viewer) => viewer.waitForBytes(warmupBytes, 120_000)));
        for (const viewer of viewerClients) {
          viewer.resetStats();
        }

        for (let repeat = 1; repeat <= repetitions; repeat += 1) {
          for (const viewer of viewerClients) {
            viewer.resetStats();
          }
          const pauseBefore = host.pauseEvents.length;
          const resumeBefore = host.resumeEvents.length;
          const send = await host.sendOutput({
            frameBytes,
            totalBytes,
            paceBytes,
            paceDelayMs,
          });
          await Promise.all(
            viewerClients.map(async (viewer) => {
              try {
                await viewer.waitForBytes(totalBytes, 5_000);
              } catch {
                // A full-speed burst can hit relay flow control; record the
                // delivered bytes instead of treating the drop as a hard error.
              }
            }),
          );
          let lastDelivered = -1;
          for (let settle = 0; settle < 20; settle += 1) {
            const delivered = viewerClients.reduce(
              (total, viewer) => total + viewer.stats().receivedPayloadBytes,
              0,
            );
            if (delivered === lastDelivered) {
              break;
            }
            lastDelivered = delivered;
            await sleep(100);
          }
          const durationMs = Math.max(1, nsToMs(send.finishedAt - send.startedAt));
          const perViewer = viewerClients.map((viewer) => viewer.stats().receivedPayloadBytes);
          const wireBytes = viewerClients.reduce(
            (total, viewer) => total + viewer.stats().receivedWireBytes,
            0,
          );
          const deliveredBytes = perViewer.reduce((total, value) => total + value, 0);
          if (deliveredBytes < send.sentBytes) {
            result.notes.push(
              `${caseName} rep ${repeat}: delivered ${deliveredBytes}/${send.sentBytes} bytes ` +
                "(flow-control drops)",
            );
          }
          const aggregate = deliveredBytes / (durationMs / 1000);
          result.results.push({
            case: caseName,
            repeat,
            payloadBytes: send.sentBytes,
            deliveredBytes,
            wireBytes,
            durationMs: Math.round(durationMs * 1000) / 1000,
            throughputBytesPerSec: Math.round(aggregate),
            perViewerBytesPerSec: perViewer.map((bytes) => Math.round(bytes / (durationMs / 1000))),
            latencyMs: summarizeLatency([]),
            flowControl: {
              pauses: host.pauseEvents.length - pauseBefore,
              resumes: host.resumeEvents.length - resumeBefore,
              pauseLatencyMs: [],
              resumeLatencyMs: [],
            },
            errors: [...host.errors, ...viewerClients.flatMap((viewer) => viewer.errors)],
          });
        }
      } catch (error) {
        failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        result.notes.push(`${caseName} failed: ${message}`);
        result.results.push({
          case: caseName,
          repeat: 0,
          payloadBytes: 0,
          wireBytes: 0,
          durationMs: 0,
          throughputBytesPerSec: 0,
          perViewerBytesPerSec: [],
          latencyMs: summarizeLatency([]),
          flowControl: { pauses: 0, resumes: 0, pauseLatencyMs: [], resumeLatencyMs: [] },
          errors: [message],
        });
      } finally {
        if (host !== null) {
          await closeSession(host, viewerClients);
        }
      }
    }
  }

  result.resources.endRssBytes = sampleRssBytes();
  result.resources.peakRssBytes = Math.max(
    result.resources.peakRssBytes,
    result.resources.endRssBytes,
  );
  result.notes.push(
    `matrix: ${frameSizes.length * viewerCounts.length} cases x ${repetitions} repetitions`,
  );
  writeResult(outPath, result);
  printSummary(result);
  return failures === 0 ? 0 : 1;
}

async function runLatency({ relayUrl, masterToken, outPath, environment, options }) {
  const viewers = options.viewers;
  const echoes = options.echoes;
  const intervalMs = options.intervalMs;
  const result = baseResult({
    scenario: "latency",
    relayUrl,
    environment,
    config: {
      scenario: "latency",
      viewers,
      echoes,
      intervalMs,
      repetitions: 1,
      warmupMs: 0,
    },
  });
  result.resources.peakRssBytes = sampleRssBytes();
  const viewerClients = [];
  let connected = null;
  try {
    connected = await connectSession({
      relayUrl,
      masterToken,
      prefix: "latency",
      viewers,
    });
  } catch (error) {
    result.notes.push(`latency failed: ${error instanceof Error ? error.message : String(error)}`);
    writeResult(outPath, result);
    printSummary(result);
    return isConnectionError(error) ? 3 : 1;
  }
  const activeHost = connected.host;
  viewerClients.push(...connected.viewers);
  try {
    for (const viewer of viewerClients) {
      viewer.resetStats();
    }
    const startedAt = nowNs();
    await Promise.all(
      viewerClients.map(async (viewer) => {
        for (let index = 0; index < echoes; index += 1) {
          viewer.sendInput({ paddingBytes: 32 });
          if (intervalMs > 0) {
            await sleep(intervalMs);
          }
        }
        await viewer.waitForLatencySamples(
          echoes,
          Math.max(30_000, echoes * (intervalMs + 20) + 10_000),
        );
      }),
    );
    const finishedAt = nowNs();
    const durationMs = Math.max(1, nsToMs(finishedAt - startedAt));
    const latency = summarizeLatency(viewerClients.flatMap((viewer) => viewer.latencySamplesMs));
    const payloadBytes = viewerClients.reduce(
      (total, viewer) => total + viewer.receivedPayloadBytes,
      0,
    );
    const wireBytes = viewerClients.reduce((total, viewer) => total + viewer.receivedWireBytes, 0);
    result.results.push({
      case: `latency/${viewers}viewer`,
      repeat: 1,
      payloadBytes,
      wireBytes,
      durationMs: Math.round(durationMs * 1000) / 1000,
      throughputBytesPerSec: Math.round(payloadBytes / (durationMs / 1000)),
      perViewerBytesPerSec: [],
      latencyMs: latency,
      flowControl: {
        pauses: activeHost.pauseEvents.length,
        resumes: activeHost.resumeEvents.length,
        pauseLatencyMs: [],
        resumeLatencyMs: [],
      },
      errors: [...activeHost.errors, ...viewerClients.flatMap((viewer) => viewer.errors)],
    });
    const lost = viewerClients.reduce(
      (total, viewer) => total + Math.max(0, echoes - viewer.latencySamplesMs.length),
      0,
    );
    if (lost > 0) {
      result.notes.push(`latency: ${lost} missing samples`);
    }
    result.resources.endRssBytes = sampleRssBytes();
    result.resources.peakRssBytes = Math.max(
      result.resources.peakRssBytes,
      result.resources.endRssBytes,
    );
    writeResult(outPath, result);
    printSummary(result);
    return lost === 0 ? 0 : 1;
  } catch (error) {
    result.notes.push(`latency failed: ${error instanceof Error ? error.message : String(error)}`);
    writeResult(outPath, result);
    printSummary(result);
    return isConnectionError(error) ? 3 : 1;
  } finally {
    await closeSession(activeHost, viewerClients);
  }
}

async function runFlow({ relayUrl, masterToken, outPath, environment }) {
  const result = baseResult({
    scenario: "flow",
    relayUrl,
    environment,
    config: { scenario: "flow", viewers: 1, repetitions: 1, warmupMs: 0 },
  });
  result.resources.peakRssBytes = sampleRssBytes();
  let failures = 0;

  // F1: pause -> resume with a trailing marker.
  {
    let host = null;
    let viewerClients = [];
    try {
      const connected = await connectSession({
        relayUrl,
        masterToken,
        prefix: "flow-f1",
        viewers: 1,
      });
      host = connected.host;
      viewerClients = connected.viewers;
      const viewer = viewerClients[0];
      viewer.resetStats();
      const totalBytes = 4 * 1024 * 1024;
      const marker = "PERF_FLOW_END";
      const markerBytes = Buffer.byteLength(marker);
      viewer.stall();
      const sendStart = nowNs();
      const pauseBefore = host.pauseEvents.length;
      const resumeBefore = host.resumeEvents.length;
      const sendPromise = host.sendOutput({
        frameBytes: 16 * 1024,
        totalBytes,
        paceBytes: 256 * 1024,
        paceDelayMs: 5,
      });
      await host.waitForControl("pause", null, 8_000);
      const pauseEvent = host.pauseEvents.at(-1);
      const pauseLatencyMs = pauseEvent ? nsToMs(pauseEvent.at - sendStart) : null;
      const resumeAt = nowNs();
      viewer.resume();
      await host.waitForControl("resume", null, 8_000);
      const resumeEvent = host.resumeEvents.at(-1);
      const resumeLatencyMs = resumeEvent ? nsToMs(resumeEvent.at - resumeAt) : null;
      const send = await sendPromise;
      const markerPromise = viewer.waitForMarker(marker, 10_000);
      host.sendMarker(marker);
      await markerPromise;
      const durationMs = Math.max(1, nsToMs(send.finishedAt - send.startedAt));
      result.results.push({
        case: "flow/pause-resume",
        repeat: 1,
        payloadBytes: totalBytes + markerBytes,
        deliveredBytes: viewer.receivedPayloadBytes,
        wireBytes: viewer.receivedWireBytes,
        durationMs: Math.round(durationMs * 1000) / 1000,
        throughputBytesPerSec: Math.round((totalBytes + markerBytes) / (durationMs / 1000)),
        perViewerBytesPerSec: [],
        latencyMs: summarizeLatency([]),
        flowControl: {
          pauses: host.pauseEvents.length - pauseBefore,
          resumes: host.resumeEvents.length - resumeBefore,
          pauseLatencyMs: pauseLatencyMs === null ? [] : [pauseLatencyMs],
          resumeLatencyMs: resumeLatencyMs === null ? [] : [resumeLatencyMs],
        },
        errors: [...host.errors, ...viewer.errors],
      });
      if (viewer.receivedPayloadBytes < totalBytes + markerBytes) {
        result.notes.push(
          `flow/pause-resume: delivered ${viewer.receivedPayloadBytes}/` +
            `${totalBytes + markerBytes} bytes (drops during pause are expected)`,
        );
      }
      const pass =
        pauseLatencyMs !== null &&
        pauseLatencyMs <= 5_000 &&
        resumeLatencyMs !== null &&
        resumeLatencyMs <= 2_000 &&
        viewer.receivedPayloadBytes > 0 &&
        host.errors.length === 0 &&
        viewer.errors.length === 0;
      if (!pass) {
        failures += 1;
        result.notes.push(
          `flow/pause-resume missed thresholds: pause=${pauseLatencyMs}ms ` +
            `resume=${resumeLatencyMs}ms bytes=${viewer.receivedPayloadBytes}`,
        );
      }
    } catch (error) {
      failures += 1;
      result.notes.push(
        `flow/pause-resume failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (host !== null) {
        await closeSession(host, viewerClients);
      }
    }
  }

  // F2: a permanently stalled viewer hits the 8 MiB hard limit while a healthy
  // viewer keeps receiving.
  {
    let host = null;
    let viewerClients = [];
    try {
      const connected = await connectSession({
        relayUrl,
        masterToken,
        prefix: "flow-f2",
        viewers: 2,
      });
      host = connected.host;
      viewerClients = connected.viewers;
      const [victim, healthy] = viewerClients;
      victim.resetStats();
      healthy.resetStats();
      const totalBytes = 10 * 1024 * 1024;
      const marker = "PERF_FLOW_END";
      const markerBytes = Buffer.byteLength(marker);
      victim.neverRead();
      const sendStart = nowNs();
      const pauseBefore = host.pauseEvents.length;
      const resumeBefore = host.resumeEvents.length;
      const sendPromise = host.sendOutput({
        frameBytes: 16 * 1024,
        totalBytes,
        paceBytes: 256 * 1024,
        paceDelayMs: 5,
        ignorePause: true,
      });
      await healthy.waitForBytes(totalBytes, 30_000);
      host.sendMarker(marker);
      await healthy.waitForBytes(totalBytes + markerBytes, 10_000);
      await sendPromise;
      let victimClose = victim.closeInfo;
      if (victimClose === null) {
        try {
          victim.resume();
          victimClose = await victim.waitForClose(5_000);
        } catch {
          // The close frame may already have been consumed; record null below.
        }
      }
      const durationMs = Math.max(1, nsToMs(nowNs() - sendStart));
      result.results.push({
        case: "flow/hard-limit",
        repeat: 1,
        payloadBytes: totalBytes + markerBytes,
        deliveredBytes: healthy.receivedPayloadBytes,
        wireBytes: healthy.receivedWireBytes,
        durationMs: Math.round(durationMs * 1000) / 1000,
        throughputBytesPerSec: Math.round((totalBytes + markerBytes) / (durationMs / 1000)),
        perViewerBytesPerSec: [],
        latencyMs: summarizeLatency([]),
        flowControl: {
          pauses: host.pauseEvents.length - pauseBefore,
          resumes: host.resumeEvents.length - resumeBefore,
          pauseLatencyMs: [],
          resumeLatencyMs: [],
        },
        errors: [...host.errors, ...healthy.errors, ...victim.errors],
      });
      const pass =
        healthy.receivedPayloadBytes >= totalBytes + markerBytes &&
        victimClose !== null &&
        victimClose.code === 4000;
      if (!pass) {
        failures += 1;
        result.notes.push(
          `flow/hard-limit missed: victim close=${victimClose?.code ?? "none"} ` +
            `healthy bytes=${healthy.receivedPayloadBytes}`,
        );
      }
    } catch (error) {
      failures += 1;
      result.notes.push(
        `flow/hard-limit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (host !== null) {
        await closeSession(host, viewerClients);
      }
    }
  }

  result.resources.endRssBytes = sampleRssBytes();
  result.resources.peakRssBytes = Math.max(
    result.resources.peakRssBytes,
    result.resources.endRssBytes,
  );
  result.notes.push("flow: 4 MiB pause/resume and 8 MiB hard-limit scenarios");
  writeResult(outPath, result);
  printSummary(result);
  return failures === 0 ? 0 : 1;
}

async function runSnapshot({ relayUrl, masterToken, outPath, environment }) {
  const result = baseResult({
    scenario: "snapshot",
    relayUrl,
    environment,
    config: { scenario: "snapshot", viewers: 1, repetitions: 1, warmupMs: 0 },
  });
  result.resources.peakRssBytes = sampleRssBytes();
  let failures = 0;

  // S1: snapshot sizes (empty, half, full 256 KiB budget).
  {
    let host = null;
    let viewerClients = [];
    try {
      const connected = await connectSession({
        relayUrl,
        masterToken,
        prefix: "snapshot-s1",
        viewers: 1,
      });
      host = connected.host;
      viewerClients = connected.viewers;
      const viewer = viewerClients[0];
      for (const bytes of [0, 128 * 1024, 256 * 1024]) {
        viewer.resetStats();
        const sentAt = nowNs();
        host.sendSnapshot({ targetId: viewer.clientId, payload: Buffer.alloc(bytes, 0x41) });
        const snapshot = await viewer.waitForSnapshot(10_000);
        const latencyMs = nsToMs(snapshot.at - sentAt);
        result.results.push({
          case: `snapshot/size-${bytes}`,
          repeat: 1,
          payloadBytes: snapshot.bytes,
          wireBytes: 0,
          durationMs: Math.round(latencyMs * 1000) / 1000,
          throughputBytesPerSec: 0,
          perViewerBytesPerSec: [],
          latencyMs: summarizeLatency([latencyMs]),
          flowControl: { pauses: 0, resumes: 0, pauseLatencyMs: [], resumeLatencyMs: [] },
          errors: [...host.errors, ...viewer.errors],
        });
        if (latencyMs > 2_000) {
          failures += 1;
          result.notes.push(`snapshot/size-${bytes} exceeded 2s (${latencyMs.toFixed(1)}ms)`);
        }
      }
    } catch (error) {
      failures += 1;
      result.notes.push(
        `snapshot/size failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (host !== null) {
        await closeSession(host, viewerClients);
      }
    }
  }

  // S2: disconnect, wait 2s, reconnect, resync, targeted snapshot.
  {
    let host = null;
    let viewer1 = null;
    let viewer2 = null;
    try {
      const connected = await connectSession({
        relayUrl,
        masterToken,
        prefix: "snapshot-s2",
        viewers: 1,
        resyncPayloadBytes: 256 * 1024,
      });
      host = connected.host;
      viewer1 = connected.viewers[0];
      host.sendSnapshot({ targetId: viewer1.clientId, payload: Buffer.alloc(256 * 1024, 0x41) });
      await viewer1.waitForSnapshot(10_000);
      await viewer1.close();
      viewer1 = null;
      await sleep(2_000);

      viewer2 = new RelayViewer({
        relayUrl,
        session: connected.session,
        sessionToken: connected.sessionToken,
        clientId: "perf-viewer-2",
      });
      await viewer2.connect();
      await host.waitForViewerCount(1);
      viewer2.resetStats();
      const sentAt = nowNs();
      viewer2.sendResync("0");
      const snapshot = await viewer2.waitForSnapshot(10_000);
      const latencyMs = nsToMs(snapshot.at - sentAt);
      result.results.push({
        case: "snapshot/reconnect-resync",
        repeat: 1,
        payloadBytes: snapshot.bytes,
        wireBytes: 0,
        durationMs: Math.round(latencyMs * 1000) / 1000,
        throughputBytesPerSec: 0,
        perViewerBytesPerSec: [],
        latencyMs: summarizeLatency([latencyMs]),
        flowControl: { pauses: 0, resumes: 0, pauseLatencyMs: [], resumeLatencyMs: [] },
        errors: [...host.errors, ...viewer2.errors],
      });
      if (latencyMs > 5_000) {
        failures += 1;
        result.notes.push(`snapshot/reconnect-resync exceeded 5s (${latencyMs.toFixed(1)}ms)`);
      }
    } catch (error) {
      failures += 1;
      result.notes.push(
        `snapshot/reconnect failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (viewer2 !== null) {
        await viewer2.close();
      }
      if (host !== null) {
        await closeSession(host, viewer1 === null ? [] : [viewer1]);
      }
    }
  }

  result.resources.endRssBytes = sampleRssBytes();
  result.resources.peakRssBytes = Math.max(
    result.resources.peakRssBytes,
    result.resources.endRssBytes,
  );
  result.notes.push("snapshot: synthetic snapshot transport sizes and reconnect resync");
  writeResult(outPath, result);
  printSummary(result);
  return failures === 0 ? 0 : 1;
}

async function runSoak({ relayUrl, masterToken, outPath, environment, options }) {
  const durationMinutes = options.durationMinutes;
  const viewers = options.viewers;
  const burstBytes = options.burstBytes;
  const burstIntervalMs = options.burstIntervalMs;
  const sampleIntervalMs = options.sampleIntervalMs;
  const result = baseResult({
    scenario: "soak",
    relayUrl,
    environment,
    config: {
      scenario: "soak",
      viewers,
      durationMinutes,
      burstBytes,
      burstIntervalMs,
      sampleIntervalMs,
      repetitions: 1,
      warmupMs: 0,
    },
  });
  result.resources.peakRssBytes = sampleRssBytes();
  const samples = [];
  let host = null;
  let viewerClients = [];
  let bursts = 0;
  let disconnected = false;
  let failures = 0;
  const startedAt = nowNs();
  const deadline = BigInt(Math.round(durationMinutes * 60 * 1000)) * 1_000_000n;
  let nextSampleAt = Date.now() + sampleIntervalMs;

  try {
    const connected = await connectSession({
      relayUrl,
      masterToken,
      prefix: "soak",
      viewers,
    });
    host = connected.host;
    viewerClients = connected.viewers;
    samples.push({
      at: new Date().toISOString(),
      clientRssBytes: sampleRssBytes(),
      relayRssBytes: sampleNamedProcessRss("workerd"),
      bursts: 0,
    });

    while (nowNs() - startedAt < deadline) {
      const before = viewerClients.map((viewer) => viewer.receivedPayloadBytes);
      await host.sendOutput({
        frameBytes: 16 * 1024,
        totalBytes: burstBytes,
        paceBytes: 256 * 1024,
        paceDelayMs: 5,
      });
      await Promise.all(
        viewerClients.map(async (viewer, index) => {
          try {
            await viewer.waitForBytes(before[index] + burstBytes, 5_000);
          } catch {
            // Flow control can drop frames during a burst; the soak records
            // stability, not a lossless delivery guarantee.
          }
        }),
      );
      let lastDelivered = -1;
      for (let settle = 0; settle < 10; settle += 1) {
        const delivered = viewerClients.reduce(
          (total, viewer) => total + viewer.stats().receivedPayloadBytes,
          0,
        );
        if (delivered === lastDelivered) {
          break;
        }
        lastDelivered = delivered;
        await sleep(100);
      }
      bursts += 1;

      if (Date.now() >= nextSampleAt) {
        const relayRssBytes = sampleNamedProcessRss("workerd");
        samples.push({
          at: new Date().toISOString(),
          clientRssBytes: sampleRssBytes(),
          relayRssBytes,
          bursts,
        });
        nextSampleAt += sampleIntervalMs;
      }

      if (host.closeInfo !== null || viewerClients.some((viewer) => viewer.closeInfo !== null)) {
        disconnected = true;
        break;
      }
      await sleep(burstIntervalMs);
    }

    if (!disconnected) {
      host.sendHostExited({ exitCode: 0 });
      await Promise.all(
        viewerClients.map((viewer) => viewer.waitForControl("host-exited", null, 10_000)),
      );
    }
  } catch (error) {
    failures += 1;
    result.notes.push(`soak failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (host !== null) {
      await closeSession(host, viewerClients);
    }
  }

  const durationMs = Math.max(1, nsToMs(nowNs() - startedAt));
  const payloadBytes = bursts * burstBytes;
  const wireBytes = viewerClients.reduce((total, viewer) => total + viewer.receivedWireBytes, 0);
  const relaySamples = samples.filter((sample) => sample.relayRssBytes !== null);
  result.results.push({
    case: `soak/${durationMinutes}m`,
    repeat: 1,
    payloadBytes,
    wireBytes,
    durationMs: Math.round(durationMs * 1000) / 1000,
    throughputBytesPerSec: Math.round(payloadBytes / (durationMs / 1000)),
    perViewerBytesPerSec: [],
    latencyMs: summarizeLatency([]),
    flowControl: {
      pauses: host?.pauseEvents.length ?? 0,
      resumes: host?.resumeEvents.length ?? 0,
      pauseLatencyMs: [],
      resumeLatencyMs: [],
    },
    errors: [...(host?.errors ?? []), ...viewerClients.flatMap((viewer) => viewer.errors)],
  });
  result.resources.endRssBytes = sampleRssBytes();
  result.resources.peakRssBytes = Math.max(
    result.resources.peakRssBytes,
    result.resources.endRssBytes,
  );
  result.resources.samples = samples;
  result.resources.peakRelayRssBytes =
    relaySamples.length === 0
      ? null
      : Math.max(...relaySamples.map((sample) => sample.relayRssBytes));
  result.resources.endRelayRssBytes =
    relaySamples.length === 0 ? null : relaySamples.at(-1).relayRssBytes;
  if (disconnected) {
    failures += 1;
    result.notes.push("soak: host or a viewer disconnected before the end");
  }
  result.notes.push(
    `soak: ${bursts} bursts of ${burstBytes} bytes, ${viewers} viewers, ` +
      `${samples.length} resource samples`,
  );
  writeResult(outPath, result);
  printSummary(result);
  return failures === 0 ? 0 : 1;
}

async function runP2P({ relayUrl, masterToken, outPath, environment, options }) {
  const bytes = options.bytes;
  const rttSamples = options.rttSamples;
  const result = baseResult({
    scenario: "p2p",
    relayUrl,
    environment,
    config: { scenario: "p2p", bytes, rttSamples, repetitions: 1, warmupMs: 0 },
  });
  result.resources.peakRssBytes = sampleRssBytes();
  try {
    const session = `perf-p2p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const run = await runRealP2P({
      relayUrl,
      masterToken,
      session,
      sessionToken: newSessionToken(),
      bytes,
      rttSamples,
    });
    result.results.push({
      case: "p2p/real-cli",
      repeat: 1,
      payloadBytes: run.payloadBytes,
      wireBytes: 0,
      durationMs: run.durationMs,
      throughputBytesPerSec: run.throughputBytesPerSec,
      perViewerBytesPerSec: [],
      latencyMs: run.latencyMs,
      flowControl: { pauses: 0, resumes: 0, pauseLatencyMs: [], resumeLatencyMs: [] },
      errors: run.errors,
      transportMode: run.transportMode,
    });
    result.notes.push(
      `p2p transport=${run.transportMode}; hostExit=${run.hostExit}; ` +
        `viewerExit=${run.viewerExit}`,
    );
    result.resources.endRssBytes = sampleRssBytes();
    result.resources.peakRssBytes = Math.max(
      result.resources.peakRssBytes,
      result.resources.endRssBytes,
    );
    const pass =
      run.transportMode.startsWith("p2p-") && run.errors.length === 0 && run.latencyMs.samples > 0;
    if (!pass) {
      result.notes.push("p2p assertions failed: no p2p transport, RTT samples, or host error");
    }
    writeResult(outPath, result);
    printSummary(result);
    return pass ? 0 : 1;
  } catch (error) {
    result.notes.push(`p2p failed: ${error instanceof Error ? error.message : String(error)}`);
    writeResult(outPath, result);
    printSummary(result);
    return 1;
  }
}

async function runCrossNat({
  relayUrl,
  masterToken,
  outPath,
  environment,
  options,
  limits = null,
}) {
  const mode = options.mode;
  if (!["relay", "relay-flow", "p2p-direct", "p2p-turn", "p2p-fallback"].includes(mode)) {
    throw new UsageError("--mode must be relay, relay-flow, p2p-direct, p2p-turn or p2p-fallback");
  }
  if (mode !== "relay" && options.viewers !== 1) {
    throw new UsageError(`--mode ${mode} requires --viewers 1`);
  }
  if (isLoopbackRelay(relayUrl)) {
    throw new UsageError("cross-nat requires a public relay URL (e.g. wss://relay.tokiapi.app)");
  }
  if (limits !== null && options.bytes * options.viewers > limits.maxBytes) {
    throw new UsageError(
      `cross-nat wire budget ${options.bytes * options.viewers} exceeds --max-bytes ${limits.maxBytes}`,
    );
  }
  const result = baseResult({
    scenario: "cross-nat",
    relayUrl,
    environment,
    config: {
      scenario: "cross-nat",
      remote: options.remote,
      mode,
      viewers: options.viewers,
      bytes: options.bytes,
      frameBytes: options.frameBytes,
      timeoutMs: options.timeoutMs,
      rttSamples: options.rttSamples,
      repetitions: 1,
      warmupMs: 0,
    },
  });
  result.resources.peakRssBytes = sampleRssBytes();
  try {
    if (mode === "relay" || mode === "relay-flow") {
      const flow = mode === "relay-flow";
      const run = await runCrossNatRelay({
        relayUrl,
        masterToken,
        remote: options.remote,
        viewers: options.viewers,
        bytes: options.bytes,
        frameBytes: options.frameBytes,
        timeoutMs: options.timeoutMs,
        flow,
        stallAfter: options.stallAfter,
        stallMs: options.stallMs,
      });
      const flowControl =
        run.flow === null
          ? { pauses: 0, resumes: 0, pauseLatencyMs: [], resumeLatencyMs: [] }
          : {
              pauses: run.flow.hostPauses,
              resumes: run.flow.hostResumes,
              pauseLatencyMs: run.flow.hostPauseAtMs === null ? [] : [run.flow.hostPauseAtMs],
              // Cross-machine clocks cannot be subtracted; report the host
              // pause window beyond the configured remote stall.
              resumeLatencyMs:
                run.flow.hostPauseWindowMs === null
                  ? []
                  : [Math.max(0, run.flow.hostPauseWindowMs - run.flow.stallMs)],
            };
      const viewerErrors = [];
      for (const viewer of run.viewers) {
        const ok = viewer.ok === true;
        const remoteErrors = Array.isArray(viewer.errors) ? [...viewer.errors] : [];
        if (!ok) {
          remoteErrors.push(viewer.error ?? viewer.stderr ?? "remote viewer failed");
        }
        viewerErrors.push(...remoteErrors);
        result.results.push({
          case: flow
            ? `cross-nat/${options.remote}/flow`
            : `cross-nat/${options.remote}/${options.viewers}viewer`,
          repeat: 1,
          payloadBytes: viewer.payloadBytes ?? 0,
          wireBytes: viewer.wireBytes ?? 0,
          durationMs: viewer.durationMs ?? 0,
          throughputBytesPerSec: viewer.throughputBytesPerSec ?? 0,
          perViewerBytesPerSec: [],
          latencyMs: viewer.latencyMs ?? summarizeLatency([]),
          flowControl,
          ...(run.flow === null ? {} : { flow: run.flow }),
          ...(viewer.stderr ? { stderr: viewer.stderr } : {}),
          errors: remoteErrors,
          remote: options.remote,
        });
      }
      result.notes.push(
        `cross-nat session=${run.session} hostSent=${run.hostSentBytes} ` +
          `hostDuration=${run.hostDurationMs}ms remote=${options.remote}`,
      );
      if (run.flow !== null) {
        const remoteStall = run.viewers[0]?.flow;
        const remoteStallMs =
          remoteStall?.stalledAt !== null &&
          remoteStall?.stalledAt !== undefined &&
          remoteStall?.resumedAt !== null &&
          remoteStall?.resumedAt !== undefined
            ? remoteStall.resumedAt - remoteStall.stalledAt
            : null;
        result.notes.push(
          `cross-nat flow stallAfter=${run.flow.stallAfter} stallMs=${run.flow.stallMs} ` +
            `hostPauseAt=${run.flow.hostPauseAtMs}ms hostResumeAt=${run.flow.hostResumeAtMs}ms ` +
            `hostPauseWindow=${run.flow.hostPauseWindowMs}ms ` +
            `remoteStall=${remoteStall?.stalledAt ?? "n/a"}..${remoteStall?.resumedAt ?? "n/a"} ` +
            `remoteStallMs=${remoteStallMs ?? "n/a"}`,
        );
        if (run.flow.hostPauses === 0 || run.flow.hostResumes === 0) {
          result.notes.push(
            "cross-nat flow: host pause/resume not observed; compare host send window " +
              "with the remote stall window before treating this as a pass",
          );
        }
      }
      if (run.hostError !== null) {
        result.notes.push(`cross-nat host send: ${run.hostError}`);
      }
      result.resources.endRssBytes = sampleRssBytes();
      result.resources.peakRssBytes = Math.max(
        result.resources.peakRssBytes,
        result.resources.endRssBytes,
      );
      const pass =
        run.hostError === null &&
        viewerErrors.length === 0 &&
        run.viewers.every((viewer) => viewer.ok === true && viewer.payloadBytes >= options.bytes) &&
        (run.flow === null || (run.flow.hostPauses >= 1 && run.flow.hostResumes >= 1));
      if (!pass) {
        result.notes.push(
          "cross-nat assertions failed: bytes missing or flow pause/resume not observed",
        );
      }
      writeResult(outPath, result);
      printSummary(result);
      return pass ? 0 : 1;
    }

    const run = await runCrossNatCli({
      relayUrl,
      masterToken,
      remote: options.remote,
      mode: mode === "p2p-turn" ? "turn" : mode === "p2p-fallback" ? "fallback" : "direct",
      bytes: options.bytes,
      rttSamples: options.rttSamples,
      timeoutMs: options.timeoutMs,
    });
    result.results.push({
      case: `cross-nat/${options.remote}/${mode}`,
      repeat: 1,
      payloadBytes: run.payloadBytes,
      wireBytes: 0,
      durationMs: run.durationMs,
      throughputBytesPerSec: run.throughputBytesPerSec,
      perViewerBytesPerSec: [],
      latencyMs: run.latencyMs,
      flowControl: { pauses: 0, resumes: 0, pauseLatencyMs: [], resumeLatencyMs: [] },
      errors: run.errors,
      transportMode: run.transportMode,
      remote: options.remote,
    });
    result.notes.push(
      `cross-nat cli session=${run.session} transport=${run.transportMode} ` +
        `iceProvider=${run.iceProvider} p2pOutcome=${run.p2pOutcome} ` +
        `fallbackMs=${run.fallbackMs ?? "n/a"} hostExit=${run.hostExit} attachExit=${run.attachExit}`,
    );
    result.resources.endRssBytes = sampleRssBytes();
    result.resources.peakRssBytes = Math.max(
      result.resources.peakRssBytes,
      result.resources.endRssBytes,
    );
    const expectedTransport =
      mode === "p2p-direct" ? "p2p-direct" : mode === "p2p-turn" ? "p2p-turn" : null;
    const transportOk =
      expectedTransport === null
        ? run.transportMode.startsWith("p2p-") || run.transportMode === "relay"
        : run.transportMode.startsWith(expectedTransport);
    const pass =
      run.errors.length === 0 &&
      run.latencyMs.samples > 0 &&
      run.payloadBytes >= options.bytes &&
      transportOk;
    if (!pass) {
      result.notes.push("cross-nat cli assertions failed: p2p transport/RTT/bytes missing");
    }
    writeResult(outPath, result);
    printSummary(result);
    return pass ? 0 : 1;
  } catch (error) {
    result.notes.push(
      `cross-nat failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    writeResult(outPath, result);
    printSummary(result);
    return 1;
  }
}

async function runCrossNatSnapshotScenario({
  relayUrl,
  masterToken,
  outPath,
  environment,
  options,
  limits = null,
}) {
  if (isLoopbackRelay(relayUrl)) {
    throw new UsageError(
      "cross-nat-snapshot requires a public relay URL (e.g. wss://relay.tokiapi.app)",
    );
  }
  if (limits !== null && options.snapshotBytes * 2 > limits.maxBytes) {
    throw new UsageError(
      `cross-nat-snapshot budget ${options.snapshotBytes * 2} exceeds --max-bytes ${limits.maxBytes}`,
    );
  }
  const result = baseResult({
    scenario: "cross-nat-snapshot",
    relayUrl,
    environment,
    config: {
      scenario: "cross-nat-snapshot",
      remote: options.remote,
      snapshotBytes: options.snapshotBytes,
      reconnectMs: options.reconnectMs,
      timeoutMs: options.timeoutMs,
      repetitions: 1,
      warmupMs: 0,
    },
  });
  result.resources.peakRssBytes = sampleRssBytes();
  try {
    const run = await runCrossNatSnapshot({
      relayUrl,
      masterToken,
      remote: options.remote,
      snapshotBytes: options.snapshotBytes,
      reconnectMs: options.reconnectMs,
      timeoutMs: options.timeoutMs,
    });
    const remoteResult = run.result;
    const errors = [
      ...run.hostErrors,
      ...(run.hostErrorMessages ?? []),
      ...(remoteResult.errors ?? []),
    ];
    const latencySamples = [remoteResult.initialLatencyMs, remoteResult.resyncLatencyMs].filter(
      (value) => Number.isFinite(value),
    );
    result.results.push({
      case: `cross-nat/${options.remote}/snapshot-reconnect`,
      repeat: 1,
      payloadBytes: (remoteResult.initialBytes ?? 0) + (remoteResult.resyncBytes ?? 0),
      wireBytes: 0,
      durationMs: remoteResult.reconnectGapMs ?? 0,
      throughputBytesPerSec: 0,
      perViewerBytesPerSec: [],
      latencyMs: summarizeLatency(latencySamples),
      flowControl: { pauses: 0, resumes: 0, pauseLatencyMs: [], resumeLatencyMs: [] },
      errors,
      remote: options.remote,
      initialBytes: remoteResult.initialBytes ?? 0,
      resyncBytes: remoteResult.resyncBytes ?? 0,
      initialLatencyMs: remoteResult.initialLatencyMs ?? null,
      resyncLatencyMs: remoteResult.resyncLatencyMs ?? null,
      reconnectGapMs: remoteResult.reconnectGapMs ?? null,
    });
    result.notes.push(
      `cross-nat snapshot session=${run.session} ` +
        `initial=${remoteResult.initialBytes ?? 0}/${options.snapshotBytes} ` +
        `resync=${remoteResult.resyncBytes ?? 0}/${options.snapshotBytes} ` +
        `reconnectGap=${remoteResult.reconnectGapMs ?? "n/a"}ms ` +
        `initialLatency=${remoteResult.initialLatencyMs ?? "n/a"}ms ` +
        `resyncLatency=${remoteResult.resyncLatencyMs ?? "n/a"}ms`,
    );
    const reconnectOk =
      typeof remoteResult.reconnectGapMs === "number" &&
      remoteResult.reconnectGapMs >= options.reconnectMs - 250;
    const pass =
      errors.length === 0 &&
      remoteResult.ok === true &&
      remoteResult.initialBytes === options.snapshotBytes &&
      remoteResult.resyncBytes === options.snapshotBytes &&
      Number.isFinite(remoteResult.initialLatencyMs) &&
      remoteResult.initialLatencyMs <= 10_000 &&
      Number.isFinite(remoteResult.resyncLatencyMs) &&
      remoteResult.resyncLatencyMs <= 10_000 &&
      reconnectOk;
    if (!pass) {
      result.notes.push("cross-nat snapshot assertions failed: bytes/latency/reconnect/errors");
    }
    result.resources.endRssBytes = sampleRssBytes();
    result.resources.peakRssBytes = Math.max(
      result.resources.peakRssBytes,
      result.resources.endRssBytes,
    );
    writeResult(outPath, result);
    printSummary(result);
    return pass ? 0 : 1;
  } catch (error) {
    result.notes.push(
      `cross-nat snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    result.resources.endRssBytes = sampleRssBytes();
    result.resources.peakRssBytes = Math.max(
      result.resources.peakRssBytes,
      result.resources.endRssBytes,
    );
    writeResult(outPath, result);
    printSummary(result);
    return 1;
  }
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;

  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  if (values.compare) {
    if (positionals.length !== 2) {
      console.error("--compare requires <baseline.json> <current.json>");
      return 2;
    }
    try {
      const baseline = loadResult(positionals[0]);
      const current = loadResult(positionals[1]);
      const comparison = compareResults(baseline, current);
      printComparison(comparison);
      return comparison.pass ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  const masterToken = process.env.TOKIMEKI_MASTER_TOKEN;
  if (masterToken === undefined || masterToken.length === 0) {
    console.error("TOKIMEKI_MASTER_TOKEN is required (do not pass tokens as CLI args)");
    return 2;
  }

  const environment = values.env ?? "local";
  const production = environment === "production";
  let limits = null;
  if (production) {
    if (values["max-bytes"] === undefined || values["max-duration"] === undefined) {
      console.error("production runs require --max-bytes and --max-duration");
      return 2;
    }
    const maxBytes = Number.parseInt(values["max-bytes"], 10);
    const maxDurationSeconds = Number.parseInt(values["max-duration"], 10);
    if (
      !Number.isFinite(maxBytes) ||
      maxBytes <= 0 ||
      !Number.isFinite(maxDurationSeconds) ||
      maxDurationSeconds <= 0
    ) {
      console.error("--max-bytes and --max-duration must be positive integers");
      return 2;
    }
    limits = { maxBytes, maxDurationSeconds };
  }

  let relayUrl;
  try {
    relayUrl = resolveRelayUrl();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const scenario = values.scenario ?? "smoke";
  const outPath = values.out ?? resolve(defaultOutDir, `perf-${scenario}-${timestampId()}.json`);
  const envLabel = production ? "production" : relayEnvironmentLabel(relayUrl);
  const common = {
    relayUrl,
    masterToken,
    outPath,
    environment: envLabel,
    limits,
  };

  try {
    if (scenario === "smoke") {
      return await runSmoke(common);
    }
    if (scenario === "local") {
      return await runLocal({
        ...common,
        options: {
          viewers: parsePositiveInteger("--viewers", values.viewers, 1),
          frameBytes: parsePositiveInteger("--frame-bytes", values["frame-bytes"], 1024),
          totalBytes: parsePositiveInteger(
            "--total-bytes",
            values["total-bytes"],
            16 * 1024 * 1024,
          ),
          warmupMs: parseNonNegativeInteger("--warmup-ms", values["warmup-ms"], 0),
        },
      });
    }
    if (scenario === "matrix") {
      const frameBytesList = values["frame-bytes"]
        ? [parsePositiveInteger("--frame-bytes", values["frame-bytes"], 1024)]
        : [1024, 65536];
      const viewersList = values.viewers
        ? [parsePositiveInteger("--viewers", values.viewers, 1)]
        : [1, 2, 4, 8];
      return await runMatrix({
        ...common,
        options: {
          frameBytesList,
          viewersList,
          totalBytes: values["total-bytes"]
            ? parsePositiveInteger("--total-bytes", values["total-bytes"], 0)
            : undefined,
          repetitions: parsePositiveInteger("--repetitions", values.repetitions, 3),
          warmupMs: parseNonNegativeInteger("--warmup-ms", values["warmup-ms"], 0),
        },
      });
    }
    if (scenario === "latency") {
      return await runLatency({
        ...common,
        options: {
          viewers: parsePositiveInteger("--viewers", values.viewers, 1),
          echoes: parsePositiveInteger("--echoes", values.echoes, 1000),
          intervalMs: parseNonNegativeInteger("--interval-ms", values["interval-ms"], 20),
        },
      });
    }
    if (scenario === "flow") {
      return await runFlow(common);
    }
    if (scenario === "snapshot") {
      return await runSnapshot(common);
    }
    if (scenario === "soak") {
      return await runSoak({
        ...common,
        options: {
          durationMinutes: parsePositiveNumber(
            "--duration-minutes",
            values["duration-minutes"],
            60,
          ),
          viewers: parsePositiveInteger("--viewers", values.viewers, 2),
          burstBytes: parsePositiveInteger("--burst-bytes", values["burst-bytes"], 1024 * 1024),
          burstIntervalMs: parseNonNegativeInteger(
            "--burst-interval-ms",
            values["burst-interval-ms"],
            5_000,
          ),
          sampleIntervalMs: parsePositiveInteger(
            "--sample-interval-ms",
            values["sample-interval-ms"],
            600_000,
          ),
        },
      });
    }
    if (scenario === "p2p") {
      return await runP2P({
        ...common,
        options: {
          bytes: parsePositiveInteger("--bytes", values.bytes, 8 * 1024 * 1024),
          rttSamples: parsePositiveInteger("--rtt-samples", values["rtt-samples"], 20),
        },
      });
    }
    if (scenario === "cross-nat-snapshot") {
      const remote = values.remote ?? "jp";
      if (remote !== "jp" && remote !== "us") {
        throw new UsageError("--remote must be jp or us");
      }
      return await runCrossNatSnapshotScenario({
        ...common,
        environment: "wan-nat-to-vps",
        options: {
          remote,
          snapshotBytes: parsePositiveInteger(
            "--snapshot-bytes",
            values["snapshot-bytes"],
            256 * 1024,
          ),
          reconnectMs: parsePositiveInteger("--reconnect-ms", values["reconnect-ms"], 2_000),
          timeoutMs: parsePositiveInteger("--timeout-ms", values["timeout-ms"], 120_000),
        },
      });
    }
    if (scenario === "cross-nat") {
      const remote = values.remote ?? "jp";
      if (remote !== "jp" && remote !== "us") {
        throw new UsageError("--remote must be jp or us");
      }
      const mode = values.mode ?? "relay";
      return await runCrossNat({
        ...common,
        environment: "wan-nat-to-vps",
        options: {
          remote,
          mode,
          viewers: parsePositiveInteger("--viewers", values.viewers, 1),
          bytes: parsePositiveInteger(
            "--bytes",
            values.bytes,
            mode === "relay-flow" ? 4 * 1024 * 1024 : 8 * 1024 * 1024,
          ),
          frameBytes: parsePositiveInteger("--frame-bytes", values["frame-bytes"], 64 * 1024),
          timeoutMs: parsePositiveInteger("--timeout-ms", values["timeout-ms"], 120_000),
          rttSamples: parsePositiveInteger("--rtt-samples", values["rtt-samples"], 20),
          stallAfter: parsePositiveInteger("--stall-after", values["stall-after"], 1024 * 1024),
          stallMs: parsePositiveInteger("--stall-ms", values["stall-ms"], 2_000),
        },
      });
    }
    console.error(`unknown scenario: ${scenario}`);
    console.error(USAGE);
    return 2;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  },
);
