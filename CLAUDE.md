# tokimeki — technical guide for AI assistants

> This file holds the implementation-level context that is intentionally kept
> out of the user-facing README. Product usage lives in `README.md` /
> `docs/cli.md`; wire contracts live in `docs/protocol.md`.

## What this is

tokimeki shares a live PTY/TUI session (Claude Code, pi, or any terminal
program) between machines. A host owns the PTY; viewers attach from another
machine. Data can travel over:

1. WebRTC DataChannel P2P (direct candidates, then TURN),
2. coturn TURN (`p2p-turn`),
3. Cloudflare Realtime TURN (`p2p-turn`),
4. the Cloudflare Worker/WebSocket relay (always available fallback).

The relay also carries control/signaling, auth, snapshots, ACKs and flow
control. It is self-hostable on Cloudflare Workers + Durable Objects.

## Release identity (0.1.0)

- CLI package: `@limccn/tokimeki` (bin `tokimeki`), version `0.1.0`.
- Protocol package: `@limccn/tokimeki-protocol`, version `0.1.0`; the CLI
  depends on it. Publish protocol **before** the CLI.
- Relay package `@tokimeki/relay` is private; deploy with Wrangler, not npm.
- License: Apache-2.0 (`LICENSE`, `NOTICE`).
- Release steps are documented in `docs/release.md`; do not run
  `npm publish`, create tags, or deploy production without explicit user
  authorization.

## Repository map

```text
packages/protocol/   wire contract: constants, zod control messages, frames, u64, goldens
packages/relay/      Worker + SessionDO: auth, routing, flow control, TURN issuance, storage
packages/cli/        CLI: cli/config, host PTY, attach viewer, transport, terminal mirror
scripts/e2e/         live e2e / cross-machine helpers
scripts/perf/        local + cross-NAT performance harnesses (results gitignored)
docs/                protocol, deployment, CLI, Cloudflare deploy, release, roadmap
assets/              README icon
.trellis/            local Trellis tasks/specs (gitignored)
```

## Relay / SessionDO notes

- `packages/relay/src/index.ts`: `/healthz`; `/ws/<session>`; mandatory
  `x-tokimeki-session`; optional `x-tokimeki-master` upgrades the role to
  host; constant-time comparisons; master token equal to session token is
  rejected; master header removed before forwarding to the DO.
- `session-do.ts`: one DO per session (`idFromName(sessionId)`); roles
  host/viewer/observer/agent; viewer `INPUT`/`RESYNC_REQ` to host; host
  `OUTPUT` broadcast; `SNAPSHOT_TO` targeted; `signal` only host↔viewer;
  reserved `listener`/`TUNNEL` return `not_implemented`; lazy schema only on
  authenticated host hello.
- Flow control: ACK-driven `unackedBytes` high water 1 MiB, low water 256 KiB,
  hard limit 8 MiB, ACK ring 256; `pause`/`resume` control messages; slow
  consumers close with code 4000. Resize is throttled (250 ms trailing) and
  resync is throttled (500 ms).
- Snapshots: host sends `SNAPSHOT_TO` at `seq=N`, then resumes `>N`; viewers
  clear and apply the snapshot; P2P switch snapshots also use relay
  `SNAPSHOT_TO` in v1.
- SQLite schema in `storage.ts`; migrations in the Wrangler config
  (`new_sqlite_classes`). TURN cache is provider-keyed with expiry.
- TURN: `TOKIMEKI_TURN_PROVIDER=auto|coturn|cloudflare|none`; coturn REST
  (HMAC) preferred, then static TURN, then Cloudflare Realtime TURN, then
  STUN-only. The CLI (libjuice) uses TURN UDP; include a
  `turn:...?transport=udp` URL.

## CLI notes

- `cli.ts` wires `claude`, `pi`, `run -- <cmd>`, `attach`, `doctor`; all
  runtime config comes from env (`.env.example` is the reference).
- `host/`: node-pty, Windows ConPTY, headless xterm mirror, mode tracker,
  resize policy (`latest|min|pinned`), snapshot/flow-control, P2P setup.
- `attach/`: raw terminal, alternate screen, snapshot apply, seq reducer,
  reconnect/resync, terminal restore.
- `transport/`: relay client, P2P peer (node-datachannel), route selector,
  ICE/TURN config, signal limits.
- Exit codes: `0` success, `1` runtime/connection (including a failed
  `doctor` check and Commander usage errors), `2` invalid `TOKIMEKI_*`
  configuration at host/attach startup.
- Logs go to stderr and are redacted; stdout carries terminal bytes only.

## Development

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm test              # protocol + cli
npm run test:relay    # Worker/DO vitest-pool-workers
npm run test:all
npm run dev:relay     # local relay, packages/relay/wrangler.jsonc
```

Live e2e: `scripts/e2e/live-e2e.mjs` (needs a running relay + tokens from
env). Performance: `scripts/perf/README.md`; cross-NAT harnesses under
`scripts/perf/remote/`.

## Deployment configs

- `wrangler.jsonc` (repo root): open-source Deploy Button / workers.dev
  contract (`main: packages/relay/src/index.ts`, DO binding, `v1` migration,
  safe default vars).
- `packages/relay/wrangler.jsonc`: production/test config (custom domain
  `relay.tokiapi.app`, production coturn URLs/Key ID).
- `npm run deploy` uses the root config; `npm run deploy:prod` uses the relay
  config. Keep shared fields in sync.
- Worker secrets: `TOKIMEKI_MASTER_TOKEN` (required), optional
  `TOKIMEKI_COTURN_SECRET`, `TOKIMEKI_TURN_API_TOKEN`,
  `TOKIMEKI_TURN_CREDENTIAL`. `.dev.vars.example` is the Deploy Button
  template; never commit real values.

## Security rules

- Never log tokens, auth headers, TURN credentials, signal payloads, or
  terminal content.
- Tokens travel in headers/stdin/0600 env files, never in argv, query strings,
  README examples, or committed files.
- The relay can see terminal bytes by design; P2P/TURN change the transport,
  not the trust model. Do not describe the relay as end-to-end encrypted.
- Production deploy/provider/secret changes need explicit user approval.
- Scan changes for master/session/TURN secrets before committing.

## Known limitations (0.1)

- Strict NAT↔NAT validation, production edge hibernation/TTL long-run, and
  real Claude/pi TUI manual acceptance remain environment-dependent.
- v1 has no DataChannel fragmentation (messages ≤16 KiB), no automatic TURN
  provider refresh/retry, and no listener/tunnel runtime; these are v1.1+
  roadmap items.
- Cross-NAT WAN flow-control pause/resume was not observed in the 2026-11-14
  tests (delivery worked); link-quality work (selective-repeat/ARQ) is future.

## Documentation

- User docs: `README.md`, `docs/cli.md`, `docs/deploy-cloudflare.md`.
- Wire protocol: `docs/protocol.md`.
- Production deployment: `docs/deployment.md`.
- Release: `docs/release.md`.
- Performance: `docs/perf/`.
- Coding conventions: `.trellis/spec/` (local-only).
- Trellis workflow: `AGENTS.md` / `.trellis/workflow.md`.
