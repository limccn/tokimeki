# Performance harness (v1)

Synthetic and real-CLI load generation for the tokimeki relay. The harness
speaks the same header + `hello` handshake as the CLI and reuses
`@limccn/tokimeki-protocol` frame/control encoders, so it measures the real relay/DO
path without PTY or terminal-rendering noise.

## Prerequisites

- Node >= 22.12, npm >= 11.
- A running relay. For local measurements:

  ```bash
  npm run build
  npx wrangler dev --config packages/relay/wrangler.jsonc \
    --var TOKIMEKI_MAX_CLIENTS_PER_SESSION:16
  ```

  The 8-viewer matrix needs `host + 8 viewers = 9` clients; the default
  `TOKIMEKI_MAX_CLIENTS_PER_SESSION=8` only fits 7 viewers. Use 16 for the
  matrix (or split the 8-viewer case onto a relay with a larger cap).

- The development master token. Do **not** pass tokens as CLI arguments:

  ```bash
  export TOKIMEKI_RELAY_URL=ws://127.0.0.1:8787
  export TOKIMEKI_MASTER_TOKEN="$(sed -n 's/^TOKIMEKI_MASTER_TOKEN=//p' packages/relay/.dev.vars)"
  ```

  For production, use `TOKIMEKI_RELAY_URL=wss://relay.tokiapi.app` and keep the
  token in an environment variable or a file read by the shell. Never commit it.

## Commands

```bash
# Wiring self-check: handshake + 1 MiB throughput + 20 echo RTTs + one snapshot
npm run perf:smoke

# Synthetic relay throughput for N viewers (one run)
npm run perf:local -- --viewers 4 --frame-bytes 1024 --total-bytes 16777216

# Full local matrix: 1/2/4/8 viewers x 1 KiB/64 KiB, 3 repetitions
npm run perf:matrix

# Latency: 1 viewer / 1000 echoes, 8 viewers / 500 echoes
npm run perf:latency -- --viewers 1 --echoes 1000 --interval-ms 20
npm run perf:latency -- --viewers 8 --echoes 500 --interval-ms 20

# Flow control: 4 MiB pause/resume and 8 MiB hard limit
npm run perf:flow

# Snapshot sizes and 2s reconnect + targeted resync
npm run perf:snapshot

# 60-minute long-run (1 host + 2 viewers by default)
npm run perf:soak -- --duration-minutes 60

# Real CLI + PTY P2P throughput/RTT (host + attach, fake settle TUI)
node scripts/perf/cli.mjs --scenario p2p --bytes 8388608

# cross-NAT relay-only: local host + remote VPS viewer (ssh-agent required)
TOKIMEKI_RELAY_URL=wss://relay.tokiapi.app \
TOKIMEKI_MASTER_TOKEN="$(cat /path/outside/repo/master-token)" \
node scripts/perf/cli.mjs --scenario cross-nat --remote jp --mode relay \
  --viewers 1 --bytes 8388608 --frame-bytes 65536

# Compare a current result against a baseline (20% degradation threshold)
npm run perf:compare -- docs/perf/baseline-v1.json scripts/perf/results/perf-local-<ts>.json
```

Production runs must be explicit and bounded:

```bash
TOKIMEKI_RELAY_URL=wss://relay.tokiapi.app \
TOKIMEKI_MASTER_TOKEN="$(cat /path/outside/repo/master-token)" \
npm run perf:matrix -- --env production --viewers 1 --frame-bytes 1024 \
  --total-bytes 8388608 --repetitions 3 \
  --max-bytes 268435456 --max-duration 120
```

Options:

| Flag | Meaning |
|---|---|
| `--scenario smoke\|local\|matrix\|latency\|flow\|snapshot\|soak` | Scenario (default `smoke`) |
| `--env local\|production` | Environment label; production requires limits |
| `--viewers <n>` | Viewer count; matrix defaults to 1/2/4/8 |
| `--frame-bytes <n>` | OUTPUT payload bytes per frame; matrix defaults to 1 KiB/64 KiB |
| `--total-bytes <n>` | Payload bytes per throughput case |
| `--repetitions <n>` | Matrix repetitions (default 3) |
| `--echoes <n>` / `--interval-ms <n>` | Latency echo count / spacing |
| `--duration-minutes <n>` | Soak duration (default 60) |
| `--burst-bytes <n>` / `--burst-interval-ms <n>` | Soak burst size / idle spacing |
| `--sample-interval-ms <n>` | Soak resource sample interval (default 10 min) |
| `--out <path>` | Result JSON path |
| `--max-bytes <n>` | Required for `--env production`; enforces wire budget |
| `--max-duration <s>` | Required for `--env production` |

Exit codes: `0` pass, `1` assertion/threshold failure, `2` usage/environment,
`3` relay unreachable.

## Output

Each run writes `scripts/perf/results/perf-<scenario>-<timestamp>.json`
(gitignored) and prints a human table. The schema is `schemaVersion: 1` and
includes:

- `run`: id, timestamp, git commit, environment, relay URL, host OS/Node/CPU.
- `config`: scenario, viewers, frame size, total bytes, repetitions, warmup.
- `results[]`: case, repeat, payload/wire bytes, duration, throughput,
  per-viewer throughput, latency percentiles, flow-control counters, errors.
- `resources`: client RSS peak/end (CPU sampling is added with the real-CLI
  and long-run scenarios).

Curated baselines live under `docs/perf/`:
`baseline-v1.json`, `report-v1.md`, `thresholds-v1.json`.

## Notes / limits

- Synthetic mode measures relay/DO behavior; it does not include PTY or
  terminal rendering. Use the real-CLI mode for P2P/TUI end-to-end runs.
- Loopback results do not represent WAN behavior; keep environments separated
  (`local-loopback`, same-LAN, cross-NAT, production edge).
- The harness never logs tokens, credentials, or `SNAPSHOT` contents beyond
  byte counts.
- Production runs must set `--env production --max-bytes ... --max-duration ...`
  and must not run the 60-minute soak.
