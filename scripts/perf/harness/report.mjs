import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { formatBytes, formatRate, median } from "./metrics.mjs";

export const RESULT_SCHEMA_VERSION = 1;

export function writeResult(path, result) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

export function loadResult(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${path} is not a perf result object`);
  }
  if (!Array.isArray(parsed.results)) {
    // Curated baselines (for example docs/perf/cross-nat-baseline-v1.json)
    // are summaries, not raw results; refusing them prevents a vacuous PASS.
    throw new Error(`${path} has no results array; not a raw perf result`);
  }
  return parsed;
}

function resultErrors(result) {
  return Array.isArray(result.errors) ? result.errors : [];
}

/** Human-readable summary of one perf result JSON. */
export function printSummary(result, { stdout = process.stdout } = {}) {
  const run = result.run ?? {};
  const out = (line) => stdout.write(`${line}\n`);
  out(`perf run: ${run.id ?? "unknown"} environment=${run.environment ?? "unknown"}`);
  out(
    `git=${run.gitCommit ?? "unknown"} relay=${run.relay?.url ?? "unknown"} ` +
      `node=${run.host?.node ?? "unknown"}`,
  );
  out("");
  out(
    "case                         repeat  payload     duration   throughput      p95(ms)  errors",
  );
  for (const entry of result.results ?? []) {
    const errors = resultErrors(entry).length;
    out(
      `${String(entry.case).padEnd(28)} ${String(entry.repeat ?? 1).padStart(6)}  ` +
        `${formatBytes(entry.payloadBytes ?? 0).padStart(10)}  ` +
        `${`${Math.round(entry.durationMs ?? 0)}ms`.padStart(9)}  ` +
        `${formatRate(entry.throughputBytesPerSec ?? 0).padStart(14)}  ` +
        `${String(entry.latencyMs?.p95 ?? 0).padStart(8)}  ${errors}`,
    );
  }
  const notes = result.notes ?? [];
  if (notes.length > 0) {
    out("");
    for (const note of notes) {
      out(`note: ${note}`);
    }
  }
}

function aggregateByCase(results) {
  const byCase = new Map();
  for (const entry of results ?? []) {
    const key = String(entry.case);
    const current = byCase.get(key) ?? { throughputs: [], p95s: [] };
    current.throughputs.push(Number(entry.throughputBytesPerSec ?? 0));
    current.p95s.push(Number(entry.latencyMs?.p95 ?? 0));
    byCase.set(key, current);
  }
  const aggregated = new Map();
  for (const [key, values] of byCase) {
    aggregated.set(key, {
      throughputBytesPerSec: median(values.throughputs),
      p95Ms: median(values.p95s),
    });
  }
  return aggregated;
}

/**
 * Compare a current result against a baseline.
 *
 * Throughput may regress by at most `maxDegradation` (default 20%); p95
 * latency may grow by at most the same fraction. Production runs are expected
 * to be compared with production baselines only.
 */
export function compareResults(baseline, current, { maxDegradation = 0.2 } = {}) {
  const baselineCases = aggregateByCase(baseline.results);
  const currentCases = aggregateByCase(current.results);
  const comparisons = [];
  const missingInBaseline = [];
  const missingInCurrent = [];

  for (const [key, cur] of currentCases) {
    const base = baselineCases.get(key);
    if (base === undefined) {
      missingInBaseline.push(key);
      continue;
    }
    const throughputChange =
      base.throughputBytesPerSec > 0
        ? (cur.throughputBytesPerSec - base.throughputBytesPerSec) / base.throughputBytesPerSec
        : null;
    const p95Change = base.p95Ms > 0 ? (cur.p95Ms - base.p95Ms) / base.p95Ms : null;
    const throughputPass = throughputChange === null || throughputChange >= -maxDegradation;
    const latencyPass = p95Change === null || p95Change <= maxDegradation;
    comparisons.push({
      case: key,
      baselineThroughputBytesPerSec: base.throughputBytesPerSec,
      currentThroughputBytesPerSec: cur.throughputBytesPerSec,
      throughputChange,
      baselineP95Ms: base.p95Ms,
      currentP95Ms: cur.p95Ms,
      p95Change,
      pass: throughputPass && latencyPass,
    });
  }

  for (const key of baselineCases.keys()) {
    if (!currentCases.has(key)) {
      missingInCurrent.push(key);
    }
  }

  return {
    pass: comparisons.every((entry) => entry.pass),
    maxDegradation,
    comparisons,
    missingInBaseline,
    missingInCurrent,
  };
}

export function printComparison(comparison, { stdout = process.stdout } = {}) {
  const out = (line) => stdout.write(`${line}\n`);
  out(
    `perf compare: ${comparison.pass ? "PASS" : "FAIL"} ` +
      `(max degradation ${(comparison.maxDegradation * 100).toFixed(0)}%)`,
  );
  for (const entry of comparison.comparisons) {
    const throughput =
      entry.throughputChange === null ? "n/a" : `${(entry.throughputChange * 100).toFixed(1)}%`;
    const p95 = entry.p95Change === null ? "n/a" : `${(entry.p95Change * 100).toFixed(1)}%`;
    out(
      `  ${entry.pass ? "PASS" : "FAIL"} ${entry.case}: ` +
        `throughput ${formatRate(entry.baselineThroughputBytesPerSec)} -> ` +
        `${formatRate(entry.currentThroughputBytesPerSec)} (${throughput}); ` +
        `p95 ${entry.baselineP95Ms}ms -> ${entry.currentP95Ms}ms (${p95})`,
    );
  }
  for (const key of comparison.missingInBaseline) {
    out(`  warn: case missing from baseline: ${key}`);
  }
  for (const key of comparison.missingInCurrent) {
    out(`  warn: case missing from current run: ${key}`);
  }
}
