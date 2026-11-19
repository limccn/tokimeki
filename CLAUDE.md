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

## Release identity (0.1.2)

- CLI package: `@limccn/tokimeki` (bin `tokimeki`), version `0.1.2`.
- Protocol package: `@limccn/tokimeki-protocol`, version `0.1.2`; the CLI
  depends on it. Publish protocol **before** the CLI.
- Relay package `@limccn/tokimeki-relay` is private; deploy with Wrangler, not npm.
- License: Apache-2.0 (`LICENSE`, `NOTICE`).
- `npm run release:bump -- <version>` updates the root/workspace versions,
  exact protocol dependencies, and `package-lock.json`; `npm run
  release:check -- <version>` verifies them.
- Pushing a `v<version>` tag triggers `.github/workflows/release.yml`, which
  verifies first, then publishes protocol before CLI to npmjs (`NPM_TOKEN`)
  and GitHub Packages (`GITHUB_TOKEN`), and finally creates the GitHub
  Release.
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
scripts/release/     version bump/check helper used by the release workflow
docs/                protocol, deployment, CLI, Cloudflare deploy, release, roadmap
assets/              README icon
.trellis/            local Trellis tasks/specs (gitignored)
```

## Relay / SessionDO notes

- `packages/relay/src/index.ts`: public `/healthz` returns only
  `{ok, service, protocolVersion}`; authenticated `GET /auth/whoami`
  (root master only, v1) returns `authMode` and TURN provider/configured with
  no-store and no secrets; `/ws/<session>` requires a non-empty
  `x-tokimeki-session`; optional `x-tokimeki-master` upgrades the role to
  host; constant-time comparisons; master token equal to session token is
  rejected; master/listener/namespace headers removed before forwarding.
- Host auth precedence: root `TOKIMEKI_MASTER_TOKEN` first, then static
  namespace tokens from `TOKIMEKI_NAMESPACE_TOKENS` (JSON
  `{ "<namespace>": "<token>" }`; `namespace-tokens.ts` validates and matches
  in constant time without early exit). Namespace hosts may only use
  `<namespace>.<slug>` sessions (dot route); the Worker derives the namespace
  from the token only and injects `x-tokimeki-namespace` (`*` for root).
  Invalid/duplicate/short/oversized maps fail closed; unset keeps the
  master-only behavior.
- `session-do.ts`: one DO per session (`idFromName(sessionId)`); roles
  host/viewer/observer/agent/listener; viewer `INPUT`/`RESYNC_REQ` to host; host
  `OUTPUT` broadcast; `SNAPSHOT_TO` targeted; `signal` only host↔viewer;
  reserved `TUNNEL` returns `not_implemented`; lazy schema only on
  authenticated host hello.
- `session_meta.namespace_id` is additive (idempotent `ALTER TABLE ... ADD
  COLUMN` in `ensureRelaySchema`, plus a legacy SELECT fallback). Hosts write
  it on create (root derives it from a dotted session id), namespace hosts
  must match it, and `NULL` legacy rows stay root/master-only. viewers and
  listeners get a defensive session-prefix check. `welcome` has no namespace
  field (the session id carries it).
- Listeners are read-only snapshot-only clients: `X-Tokimeki-Listener: 1` at
  the Worker selects the role (master token still wins as host), they are
  capped by `TOKIMEKI_MAX_LISTENERS` (default 8) on top of `maxClients`, receive
  relay `SNAPSHOT_TO` only, and are excluded from `OUTPUT`, ACK/unacked bytes,
  pause/resume, slow-consumer, resize, and P2P. INPUT/resize/resync/ack/signal/
  transport/ice-refresh from a listener returns `invalid_role`. Listeners never
  receive TURN credentials: their `welcome` is STUN-only (`iceProvider:"stun"`,
  `iceExpiresAt: null`).
- Flow control: ACK-driven `unackedBytes` high water 1 MiB, low water 256 KiB,
  hard limit 8 MiB, ACK ring 256; `pause`/`resume` control messages; slow
  consumers close with code 4000. Listeners never enter this accounting.
  Resize is throttled (250 ms trailing) and resync is throttled (500 ms).
- Session limits: `TOKIMEKI_SESSION_MAX_TTL_SECONDS` (default 86400, `0` off)
  is an absolute lifetime from creation that a host reconnect cannot extend;
  `TOKIMEKI_SESSION_IDLE_TTL_SECONDS`, `TOKIMEKI_SESSION_MAX_BYTES`, and
  `TOKIMEKI_SESSION_MAX_MESSAGES_PER_SECOND` default 0 (off). TTL expiry closes
  with `host_exited`/4004, quota breaches with `session_full`/4002 — no new
  error codes, and the shared PTY is never paused. Byte accounting covers
  relay-delivered `OUTPUT`/`SNAPSHOT_TO`/`INPUT` frames only (once per frame)
  and is approximate (1 MiB flush window); P2P/TUN bytes are not counted.
- Snapshots: host sends `SNAPSHOT_TO` at `seq=N`, then resumes `>N`; viewers
  clear and apply the snapshot; P2P switch snapshots also use relay
  `SNAPSHOT_TO` in v1.
- SQLite schema in `storage.ts`; migrations in the Wrangler config
  (`new_sqlite_classes`). TURN cache is provider-keyed with expiry.
- TURN: `TOKIMEKI_TURN_PROVIDER=auto|coturn|cloudflare|none`; coturn REST
  (HMAC) preferred, then static TURN, then Cloudflare Realtime TURN, then
  STUN-only. The CLI (libjuice) uses TURN UDP; include a
  `turn:...?transport=udp` URL. Credential TTL defaults to 900s (15 min);
  `TOKIMEKI_COTURN_TTL_SECONDS` / `TOKIMEKI_TURN_TTL_SECONDS` override it and
  Cloudflare still clamps to 172800s.

## CLI notes

- `cli.ts` wires `claude`, `pi`, `run -- <cmd>`, `attach` (`--listen` for
  read-only listener mode), `doctor`; all runtime config comes from env
  (`.env.example` is the reference). Host auth accepts
  `TOKIMEKI_MASTER_TOKEN` or `TOKIMEKI_NAMESPACE_TOKEN` +
  `TOKIMEKI_NAMESPACE` (namespace wins with a warning when both are set);
  namespace mode auto-prefixes `<namespace>.` sessions and rejects an explicit
  `TOKIMEKI_SESSION` without it.
- `host/`: node-pty, Windows ConPTY, headless xterm mirror, mode tracker,
  resize policy (`latest|min|pinned`), snapshot/flow-control, P2P setup, and a
  separate periodic listener snapshot timer (`TOKIMEKI_LISTENER_SNAPSHOT_MS`,
  default 1000 ms) that never pauses the PTY.
- `attach/`: raw terminal, alternate screen, snapshot apply, seq reducer,
  reconnect/resync, terminal restore; listener mode sends no input/resize/ACK/
  resync/P2P and Ctrl-C exits only the local listener.
- `transport/`: relay client, P2P peer (node-datachannel), fragmentation,
  ICE config/refresh, P2P retry policy, route selector, ICE/TURN config, signal
  limits.
- `transport/tunnel/`: v1.1 F1/F1.1 TUN profile — HKDF direction keys +
  AES-256-GCM records (`crypto.ts`), selective-repeat ARQ (`arq.ts`), XOR
  parity (`fec.ts`), capability/offer negotiation (`capability.ts`), and the
  P2P endpoint (`tunnel-transport.ts`). It is opt-in (`TOKIMEKI_TUNNEL=auto`),
  P2P-only, and falls back to the relay; the relay still rejects `TUNNEL` with
  `not_implemented`. `TOKIMEKI_TUNNEL_FEC=xor` advertises and negotiates
  `fec:["none","xor"]` for single-loss parity; default `off` keeps F1 behavior.
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
  `TOKIMEKI_NAMESPACE_TOKENS` (static namespace host tokens, JSON object),
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
  TUN's default `session-token` keyMode is derivable by the relay; only
  `TOKIMEKI_TUNNEL_SECRET` (`shared-secret`) may be called relay-blind.
- `TOKIMEKI_TUNNEL_SECRET` is scrubbed from the hosted PTY environment and
  redacted from logs; never log tunnel keys, nonces, ciphertext, or plaintext.
- Production deploy/provider/secret changes need explicit user approval.
- Scan changes for master/session/TURN secrets before committing.

## Known limitations (0.1)

- Strict NAT↔NAT (including P2P attempts and relay fallback) and real Claude/pi
  TUI interaction were manually confirmed at the e2e layer on 2026-11-16; this
  is not long-run/production, direct-path success-rate, or exhaustive
  interaction acceptance. Production edge hibernation/TTL long-run remains
  environment-dependent.
- v1.1 F0 adds capability-gated `FRAGMENT 0x08` DataChannel fragmentation,
  P2P direct snapshots, automatic ICE refresh, and one provider retry. v1.1 F2
  adds the read-only snapshot-only `listener` role. v1.1 F1 adds the opt-in
  P2P-only TUN profile (AEAD + selective-repeat ARQ); F1.1 adds opt-in XOR
  parity (`TOKIMEKI_TUNNEL_FEC=xor`, capability `fec:["none","xor"]`) for
  exactly-one-record recovery, with multi-loss/lost-parity still on ARQ. Local
  tunnel e2e passes for session-token and shared-secret key modes; cross-machine
  tunnel e2e, forced loss/reorder injection (including FEC recovery), and
  secret-mismatch fallback remain to be run. The host/attach tunnel switch has
  no pure unit test (live e2e covers it). There is still no listener
  incremental/safe-boundary output.
- Cross-NAT WAN flow-control pause/resume was not observed in the 2026-11-14
  tests (delivery worked); link-quality work beyond the F1/F1.1 tunnel
  (fragmentation-independent ARQ tuning, Reed-Solomon/multi-loss FEC) is future.
  A v2.0 lossy-network A/B validation (SCTP reliable vs TUN SR-ARQ/FEC) is
  planned; see `docs/roadmap.md` and `docs/tunnel-reliability.md`.

## Documentation

- User docs: `README.md`, `docs/cli.md`, `docs/deploy-cloudflare.md`.
- Wire protocol: `docs/protocol.md`.
- TUN reliability trade-off (SR-ARQ vs SCTP; v2.0 A/B plan):
  `docs/tunnel-reliability.md`.
- Production deployment: `docs/deployment.md`.
- Release: `docs/release.md`.
- Performance: `docs/perf/`.
- Coding conventions: `.trellis/spec/` (local-only).
- Trellis workflow: `AGENTS.md` / `.trellis/workflow.md`.
