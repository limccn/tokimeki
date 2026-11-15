import { execFileSync } from "node:child_process";
import os from "node:os";

/** Monotonic nanoseconds for latency measurements. */
export function nowNs() {
  return process.hrtime.bigint();
}

export function nsToMs(ns) {
  return Number(ns) / 1e6;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Linear-interpolated percentile over an ascending sorted array. */
export function percentile(sorted, p) {
  if (sorted.length === 0) {
    return 0;
  }
  if (sorted.length === 1) {
    return sorted[0];
  }
  const rank = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) {
    return sorted[low];
  }
  const weight = rank - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

/** Percentile summary for latency samples in milliseconds. */
export function summarizeLatency(samples) {
  const finite = samples.filter((value) => Number.isFinite(value) && value >= 0);
  if (finite.length === 0) {
    return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0, samples: 0 };
  }
  const sorted = [...finite].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    p50: round3(percentile(sorted, 0.5)),
    p95: round3(percentile(sorted, 0.95)),
    p99: round3(percentile(sorted, 0.99)),
    min: round3(sorted[0]),
    max: round3(sorted[sorted.length - 1]),
    mean: round3(sum / sorted.length),
    samples: sorted.length,
  };
}

/** Median of a numeric list, used to collapse repeated throughput runs. */
export function median(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return 0;
  }
  const sorted = [...finite].sort((a, b) => a - b);
  return percentile(sorted, 0.5);
}

export function round3(value) {
  return Math.round(value * 1000) / 1000;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "n/a";
  }
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

export function formatRate(bytesPerSec) {
  return `${formatBytes(bytesPerSec)}/s`;
}

/** Static environment description recorded in every result JSON. */
export function collectEnvironment({ relayUrl, environment, relayVersion = null }) {
  let gitCommit = null;
  try {
    gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    // Not a git checkout; leave null rather than failing the run.
  }
  const cpu = os.cpus()[0];
  return {
    gitCommit,
    environment,
    relay: { url: relayUrl, version: relayVersion },
    host: {
      os: `${os.type()} ${os.release()}`,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: cpu?.model ?? "unknown",
      cpuCount: os.cpus().length,
      memoryBytes: os.totalmem(),
    },
  };
}

/** Current process RSS, sampled before/after a run. */
export function sampleRssBytes() {
  return process.memoryUsage().rss;
}

/**
 * Best-effort RSS for a named process (default: the local `workerd` runtime).
 * Returns null when the process is unavailable or the platform command fails.
 */
export function sampleNamedProcessRss(name = "workerd") {
  try {
    if (process.platform === "win32") {
      const output = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p = Get-Process -Name ${name} -ErrorAction SilentlyContinue; ` +
            `if ($null -eq $p) { "" } else { ($p | Measure-Object WorkingSet64 -Sum).Sum }`,
        ],
        { encoding: "utf8", timeout: 8_000 },
      ).trim();
      const value = Number(output);
      return Number.isFinite(value) && value > 0 ? value : null;
    }
    const output = execFileSync("ps", ["-C", name, "-o", "rss="], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    const kilobytes = output
      .split(/\s+/)
      .filter(Boolean)
      .reduce((total, value) => total + Number(value), 0);
    return Number.isFinite(kilobytes) && kilobytes > 0 ? kilobytes * 1024 : null;
  } catch {
    return null;
  }
}

export function timestampId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}
