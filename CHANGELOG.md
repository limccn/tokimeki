# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.9] - 2026-11-26

Fixed-grid live resize. No change to the existing viewer -> host `resize`
message or to P2P/TUN behavior.

### Added

- Protocol: additive `display-size` control message and optional
  `display.resize` capability. The message is host-only and validated against
  the existing terminal cell limits.
- Relay: the host attachment carries the current fixed grid; a host
  `display-size` updates it, `saveAttachment` persists it across hibernation,
  and the relay broadcasts only to clients that advertise `display.resize`.
  `welcome.clients` reports the updated size so late-joining old clients render
  correctly.
- CLI host: F12 "Resize hosted window" works for fixed-grid hosts when the
  relay and every connected viewer/listener advertise `display.resize`; the
  host resizes the PTY/mirror, sends `display-size`, and schedules fresh
  snapshots. A snapshot in flight defers the resize to keep the control message
  ordered before the new-size snapshot.
- CLI viewer/listener: handle `display-size` by rebuilding the fixed
  viewport/mirror and waiting for the next snapshot; the listener remains
  read-only and never sends input/resize/ACK/resync.
- Focused live e2e: host + two viewers + listener + legacy gate + reconnect
  (`npm run e2e:display-resize`).

### Compatibility

- Old viewers/listeners do not advertise `display.resize`; the host refuses
  live fixed resize while they are connected. A late-joining old client reads
  the updated fixed size from `welcome`.
- The TokiAPI web viewer does not advertise `display.resize` in this release;
  the host blocks live resize while it is connected. Live web-viewer support is
  a separate cross-repo follow-up.
- No SQL schema change; the relay uses the existing WebSocket attachment.

### Security

- `display-size` carries only dimensions; no token, terminal content, or
  client input. Logs contain sizes and counts only.

## [0.1.8] - 2026-11-26

v1.7 hardening: opt-in slow-P2P fallback and send pacing, relay per-IP edge
limits, opaque-token and passcode lockouts, uniform unauthorized for opaque
viewer/listener tokens, and a bounded CLI 429 retry policy. No wire-protocol
change.

### Added

- Host: opt-in `TOKIMEKI_P2P_DRAIN_BYTES_PER_SEC` returns only the affected
  viewer to the relay when a ready P2P/TUN link has at least 64 KiB buffered
  and drains below the configured rate over a 3 s window.
- Host: opt-in `TOKIMEKI_SEND_PACE_BYTES_PER_SEC` paces snapshots and OUTPUT
  above 1024 payload bytes with a process-wide token bucket, small-OUTPUT
  priority, an 8 s per-snapshot floor, and 1 MiB/256 KiB queue bounds.
- Relay: optional `TOKIMEKI_WS_IP_LIMIT` edge binding (30/60s/IP) for `/ws`
  upgrades; 429 + `Retry-After: 60`; fail-open with logs when the binding or
  edge IP is absent.
- Relay: per-IP opaque-token failure lock (10/60s -> 60 s) on existing
  sessions; success clears the counter.
- Relay: per-IP passcode main lock (5/60s -> 60 s) plus a per-session high
  threshold (50/60s -> 60 s) for distributed guessing.
- CLI: six consecutive HTTP 429 upgrade rejections become a fatal
  `session_full` (exit 1); 503/JWKS retries keep the existing policy.
- TokiAPI (separate deployment): dedicated `/api/tokimeki/ws` rate-limit bucket
  (`TOKIMEKI_WS_LIMIT`) and trusted `x-real-ip` forwarding to the relay.

### Changed

- Opaque viewer/listener token errors are now a uniform `unauthorized`
  (nonexistent session, wrong token, and IP lock); the session-existence
  oracle is removed. Session JWT and host errors keep their specific messages.
- The per-session passcode lock is now a high-threshold fallback; a single
  source can no longer lock every viewer after five failures.
- Deployment docs cover the new binding, fail-open behavior, NAT caveats,
  rollback, HTTPS/HSTS/WAF, and Static Assets route checks.

### Security

- Failed-auth counters store only `sha256(client IP)`; logs never include raw
  IPs, tokens, passcodes, verifiers, or terminal content.
- Relay rate limiting is best-effort (per-location, eventually consistent);
  it is not described as “brute-force proof”.
- The relay still sees terminal bytes by design; P2P/TURN change the transport,
  not the trust model.

## [0.1.7] - 2026-11-24

Security hardening for v1.4/v1.5 code across the CLI, relay, onboarding site,
and the separate `tokimeki-dsh` plugin. No wire-protocol or credential-format
change.

### Security

- CLI: sanitize remote log/provider text before terminal/log output; scrub
  `TOKIMEKI_ATTACH_URL`/`TOKIMEKI_CONFIG_FILE` from the hosted PTY; reject
  non-loopback plaintext relay URLs; cap authenticated `/auth/whoami` bodies;
  reject symlinked `~/.tokimeki/config.json`; drop stale cross-relay
  credentials on save; validate `TOKIMEKI_MASTER_TOKEN` header safety.
- Onboarding site: IPv6 loopback support, stale-output invalidation, short
  session-token compatibility, window cell/dimension limits, `windowMode` in
  the downloaded host config, host/session token equality, delayed blob revoke.
- Relay: bounded peer-joined capabilities; retain host-exit/TURN fallback
  diagnostics; remove the `change-me` master placeholder from
  `.dev.vars.example`.
- `tokimeki-dsh` (separate repository): Windows doctor current-directory
  hardening, timeout escalation, expanded redaction, and config-path quoting;
  its public npm release is deferred until `NPM_TOKEN` is configured.

### Fixed

- Prompt EOF aborts instead of hanging; master mode clears an inherited
  namespace; share-URL attach reads config-layer passcode/`TOKIMEKI_ATTACH_URL`;
  history writes are serialized inside the lock; empty history tokens are
  treated as missing; non-TTY attach no longer resizes the shared PTY.

### Changed

- Onboarding label is now “Show token fields”; the site build cleans `dist`;
  the v1.4 e2e asserts asset CSP/nosniff/referrer/no-store headers.

## [0.1.6] - 2026-11-23

Agent onboarding (v1.5): universal skill, install prompt, and release
distribution. The CLI code is unchanged from 0.1.5; the skill is distributed
from this repository's `skills/tokimeki/` directory.

### Added

- `skills/tokimeki/SKILL.md` plus command/troubleshooting references: prompt-only
  (no hooks/scripts/MCP/postinstall), default read-only, hard filesystem/
  environment limits, host paths aligned with v1.4, token-safe attach, and
  uninstall/removal instructions. Installed with
  `npx skills add limccn/tokimeki --skill tokimeki` (project scope; `-g` for
  global). There is no registry short name.
- `docs/agent-install.md` copy-paste prompt covering skill installation, CLI
  installation, and `tokimeki doctor` expectations.
- Independent `@limccn/tokimeki-dsh` DeepSeek Harness plugin
  (`https://github.com/limccn/tokimeki-dsh`): native dsh bundle with read-only/
  plan-only `tokimeki_doctor`, `tokimeki_status`, `tokimeki_host_plan`,
  `tokimeki_attach_plan`, and `tokimeki_share_plan`. No host_start, no
  deployment, no arbitrary shell, no token/file-content reads, no plugin-owned
  network calls.

## [0.1.5] - 2026-11-23

v1.4 user onboarding: interactive/daemon modes, doctor-first host/attach
wizards, TokiAPI anonymous provisioning, hosted config-file/share-URL entry,
F12 connection menu, config/history persistence, ACP catalog, CLI UX, and the
no-JWT static onboarding site.

### Added

- CLI modes: top-level `--interactive`/`--daemon`, `TOKIMEKI_MODE`, TTY
  detection, non-TTY+interactive config error, and daemon events on stderr
  (`tokimeki-event: ` + JSON schema v1: ready/status/error/report). Events are
  independent of log level/muting; stdout stays terminal bytes/doctor report.
- Doctor-first host/attach startup. Host wizard paths: existing token
  (recommended `TOKIMEKI_TOKEN`; master deprecated alias), self-hosted guidance
  (one-click Cloudflare Deploy Button + docs; never runs wrangler), and TokiAPI
  anonymous host (`GET /api/config`, `POST /api/tokimeki/anon-host`; 24h
  default, 429/503, invite URL memory-only). Attach wizard accepts invite
  URL/code, viewer config JSON, history, or manual input, with a same-connection
  pre-ready test and retry/re-enter.
- `tokimeki --config <file>` / `TOKIMEKI_CONFIG_FILE` (v1/v2 envelope,
  host-only, regular/no-symlink/≤64 KiB/0600, partial-file relay+credential
  guard) and `tokimeki attach <share-url>` / `TOKIMEKI_ATTACH_URL`/`-`
  (provider `api/config` + `attach/cli` exchange, wss/origin binding, 410/429/
  503/passcodeRequired, Session JWT memory-only).
- Explicit config/history persistence: wizard-only `writeUserConfig` (five-key
  whitelist, 0600/atomic/no-follow/lock, JWT-shaped session token rejected) and
  `~/.tokimeki/history.json` (20-entry LRU, no host tokens/Session JWTs);
  `tokimeki history [list|remove|clear]`.
- F12 connection menu replacing the invite-only overlay: host status/session/
  token (masked, reveal/copy), viewer-config OSC 52 copy, anonymous invite URL
  (memory only), viewer/listener reconnect/disconnect, log-view entry; PTY size
  unchanged and keys never reach the PTY. F11 full-screen log view; wide-terminal
  40x8 bottom-right debug log area with 120/118 hysteresis; `TOKIMEKI_LOG_VIEW_ROWS`
  (default 200/max 2000/0 off); `TOKIMEKI_LOG_PANEL_ROWS` deprecated.
- ACP catalog: claude/pi/codex/gemini/cursor/aider/opencode/goose/amp are the
  default fixed-window/dynamic allow-list; `tokimeki acp list [--detect]`
  (read-only PATH scan; never executes binaries) and `.com` suffix handling.
- no-JWT onboarding site (`packages/onboarding-site`) served by the relay
  through Workers Static Assets: same-origin `wss://` relay, host/attach
  command generation, v1 config/viewer JSON downloads, CSP
  `connect-src 'none'`, no storage/analytics/backend/JWT. Both Wrangler configs
  add `assets` with `not_found_handling: "none"` so `/ws`, `/healthz`, and
  `/auth` stay Worker routes.
- Host TUI child environment scrub covers `TOKIMEKI_CONFIG_FILE`,
  `TOKIMEKI_ATTACH_URL`, and `TOKIMEKI_PASSCODE`; daemon startup suppresses the
  sessionToken-bearing banner.

### Known limitations

- Fixed-window live resize from the F12 menu is deferred to v1.8: v1 has no
  wire message to update viewers' fixed-grid capabilities, so applying a new
  PTY size would desync existing viewers. Non-fixed `latest`/`min`/`pinned`
  policies support the resize editor.
- TokiAPI anonymous host live verification relies on the user-confirmed
  production functional tests (2026-11-23); local e2e uses a mock provider.
- v1.7 per-IP rate limiting and v1.8 credential/session lifecycle (revocation,
  rotation, stale config cleanup) remain unimplemented.

## [0.1.4] - 2026-11-21

JWT/hosted-auth line, based on 0.1.3: Session JWT viewer/listener verification, share links/web viewer contract, optional passcode, and cross-repo e2e.

### Added

- Relay **Session JWT** verification (v1.2-A): when JWT mode is enabled, a
  three-segment `X-Tokimeki-Session` is verified as `token_use=session` with
  `attach`/`listen` scope, an exact `session` claim, and the token namespace
  prefix. Verified viewers/listeners reach the SessionDO with
  `x-tokimeki-session-claim`/`-scope`; the DO re-checks session/namespace/scope
  and skips the opaque `host_token_hash` comparison. Legacy
  `namespace_id=NULL` sessions keep the opaque path only. Session JWTs are
  never host credentials; JWT-disabled mode leaves opaque tokens unchanged.
- Optional **session passcode** (v1.2-D): `TOKIMEKI_PASSCODE` (6..128 chars)
  makes the host send only a PBKDF2-SHA256 verifier in `hello.passcode`;
  viewers/listeners submit `X-Tokimeki-Passcode`. The relay stores the verifier
  in `session_passcode`, locks verification for 30 s after five failures, and
  advertises `welcome.capabilities.sessionSecurity.passcode=1`. New error codes
  `passcode_required`/`passcode_invalid`/`passcode_locked`/`passcode_mismatch`;
  unset passcode behavior is unchanged. The CLI scrubs the passcode from the
  hosted PTY environment and logs.
- CLI accepts a TokiAPI **Session JWT** in `TOKIMEKI_SESSION_TOKEN` as an
  opaque value (no parsing/refresh); viewer config envelopes accept `v:2`
  (`namespace`, `expiresAt`, `passcodeRequired`). `docs/web-viewer.md` records
  the TokiAPI proxy contract, TURN stripping, passcode handshake, and the
  cross-repo e2e harness (`scripts/e2e/v1.2-cross-repo.mjs`) plus a
  passcode-specific harness (`scripts/e2e/v1.2-passcode-e2e.mjs`) covering
  CLI passcode success/failure and the Web proxy first-frame gate.
- Test-only `TOKIMEKI_JWT_ALLOW_HTTP=1` allows a loopback `http://` JWKS URL
  for local cross-repo e2e; production must leave it unset.

## [0.1.3] - 2026-11-20

Default/no-jwt mainline: static multi-namespace host tokens, the additive
`session_meta.namespace_id` migration, authenticated `/auth/whoami`, opt-in
session TTL/byte/message limits, and the optional Host JWT credential
alignment (`TOKIMEKI_TOKEN` + `X-Tokimeki-Token`; JWT verification stays
disabled unless configured). The Session JWT/share-link/passcode line is
maintained separately as 0.1.4.


### Added

- Minimal TokiAPI Host JWT verification (task `11-19-v1-2-cli-tokiapi-host-jwt`):
  the relay optionally verifies ES256 Host JWTs offline (`TOKIMEKI_JWT_JWKS_URL`,
  `TOKIMEKI_JWT_ISSUER`, `TOKIMEKI_JWT_AUDIENCE`, `TOKIMEKI_JWT_JWKS_TTL_SECONDS`,
  `TOKIMEKI_JWT_CLOCK_SKEW_SECONDS`) with a per-isolate JWKS cache, strict
  claims validation (`token_use=host`, `scope` containing `host`, namespace
  claim + `<namespace>.<slug>` session prefix), fail-closed invalid config,
  and `503 jwks_unavailable` when the JWKS is unreachable. Unset JWKS URL
  keeps JWT mode fully disabled (no parsing, no Authorization handling, no
  JWKS traffic).
- `Authorization: Bearer <Host JWT>` as a second carrier, accepted only while
  JWT mode is enabled and only when `X-Tokimeki-Token` is absent/empty;
  stripped before the SessionDO in non-disabled modes. The CLI never sends it.
- CLI host credential `TOKIMEKI_TOKEN`: one opaque value for a TokiAPI Host
  JWT or a static namespace token, always sent on `X-Tokimeki-Token`, with a
  required `TOKIMEKI_NAMESPACE` (paired error messages, auto-prefixed
  sessions). Read-only `~/.tokimeki/config.json` support with
  env > `TOKIMEKI_CONFIG` > file precedence, host credentials selected per
  source layer, and POSIX 0600 enforcement. `doctor` probes `/auth/whoami`
  with the effective credential and reports `authMode=jwt|namespace|master`.
- Static namespace host tokens for OSS multi-namespace hosting:
  `TOKIMEKI_NAMESPACE_TOKENS` maps a namespace to a host token, namespace
  sessions use `<namespace>.<slug>`, and the CLI uses `TOKIMEKI_TOKEN` +
  `TOKIMEKI_NAMESPACE` (`TOKIMEKI_NAMESPACE_TOKEN` is retired). Includes an additive
  `session_meta.namespace_id` migration; unset preserves master-only behavior.
- Authenticated `GET /auth/whoami` (root master in v1) exposes TURN
  provider/configured diagnostics while the public `/healthz` stays minimal.
- Opt-in session limits: absolute/idle TTL and per-session byte/message hard
  caps via `TOKIMEKI_SESSION_MAX_TTL_SECONDS`,
  `TOKIMEKI_SESSION_IDLE_TTL_SECONDS`, `TOKIMEKI_SESSION_MAX_BYTES`, and
  `TOKIMEKI_SESSION_MAX_MESSAGES_PER_SECOND`.

### Changed

- **Breaking**: the host header was renamed `X-Tokimeki-Master` →
  `X-Tokimeki-Token`. The old header is no longer accepted; CLI and relay must
  be upgraded together.
- **Breaking**: `TOKIMEKI_NAMESPACE_TOKEN` is retired. A non-empty value exits
  2 with a hint to rename it to `TOKIMEKI_TOKEN`; no compatibility fallback.
- **Breaking**: enabling a valid `TOKIMEKI_NAMESPACE_TOKENS` map immediately
  disables `TOKIMEKI_MASTER_TOKEN` and root `*` takeover (fallback hosts 401
  even when the value matches); only namespace tokens and Host JWTs
  authenticate hosts in that mode. Relay logs `fallback_token_disabled` while
  the master secret is still set. `/auth/whoami` now reports
  `authMode=jwt|namespace|master` accordingly.
- Renamed the private relay workspace package to `@limccn/tokimeki-relay` for
  npm scope consistency. Relay deployment and the public npm packages are
  unchanged.
- Replaced the repository banner artwork with the new 1024×512 illustration
  and removed the unused `banner-paint.png`, `icon-1254.png`, and `icon.svg`
  sources. Both READMEs continue to use `assets/icon.png`.
- Listener connections are STUN-only and can no longer obtain TURN
  credentials; listener `ice-refresh` returns `invalid_role`.
- Public `/healthz` now returns only `{ok, service, protocolVersion}`; use the
  authenticated `/auth/whoami` for TURN details.
- TURN credential default TTL is 15 minutes (900s); explicit env overrides and
  the Cloudflare 172800s cap are unchanged.
- Session absolute TTL defaults to 24h; idle/byte/rate caps default off.

### Fixed

- Doctor sanitizes the relay-provided TURN provider string before printing and
  treats a missing whoami endpoint on older relays as a warning.

### Documentation

- README (English and Chinese) now documents v1.1 configuration: read-only
  listeners (`tokimeki attach --listen`, `TOKIMEKI_LISTENER_SNAPSHOT_MS`,
  relay `TOKIMEKI_MAX_LISTENERS`), the opt-in P2P TUN profile
  (`TOKIMEKI_TUNNEL`, `TOKIMEKI_TUNNEL_FEC`, `TOKIMEKI_TUNNEL_SECRET`), LAN
  diagnostics and reserved routing variables, and automatic P2P behavior.
- Added `docs/tunnel-reliability.md` (SR-ARQ vs SCTP trade-offs) and the v2.0
  weak-network A/B validation plan. That validation is currently postponed.
- Added `docs/relay-exposure-policy.md` (public surface, namespace gating, TURN
  limits, and the master -> static namespace token -> JWT/TokiAPI route) and
  updated CLI/protocol/deployment docs for `/auth/whoami`, the listener TURN
  gate, the 900s TURN default, namespace tokens, and session limits.

## [0.1.2] - 2026-11-16

### Added

- Fixed TUI window and full-screen viewport: commands listed in
  `TOKIMEKI_WINDOW_TUI` (default `claude,pi`) get a session-level logical grid
  (`TOKIMEKI_WINDOW_SIZE`, default `120x40`). Viewer `resize` and local terminal
  resizes no longer change the hosted PTY, so attaching never re-lays out the
  TUI. Local terminals letterbox the grid when larger and crop with cursor
  following when smaller.
- Dynamic TUI subcommands: `TOKIMEKI_WINDOW_TUI` is also the allow-list, so
  `TOKIMEKI_WINDOW_TUI=claude,pi,omp` enables `tokimeki omp` without a code
  change. Known commands keep precedence; unlisted unknown commands are
  rejected with an actionable usage error.
- Bottom status bar (`tokimeki  host  session=...  relay:ready  viewers:2
  relay  120x40  view:fit`), mouse coordinate translation into the logical
  grid, and a debug log panel above the status bar (`TOKIMEKI_LOG_PANEL_ROWS`,
  default 8; debug only).
- Protocol `hello.client` (User-Agent-like identity) and
  `capabilities.display` (`fixed-grid`, `viewport`, `fixed`, `logPanel`,
  `terminalQueries`); the relay echoes both in `welcome.clients` /
  `presence.clients`. The wire version stays `v: 1`; older peers/relays ignore
  the optional fields.
- F12 viewer-config overlay in the host viewport: after the startup banner
  scrolls away, press `F12` (configurable `TOKIMEKI_INVITE_KEY=f12|ctrl-]|off`)
  to show the session, relay, token, and copyable viewer config JSON; `c` copies
  the exact JSON through OSC 52. The overlay is local, host-side only, and never
  writes a file.
- `TOKIMEKI_CONFIG` JSON config envelope: fields map onto existing
  `TOKIMEKI_*` variables, explicit env vars win, JSON only, and the envelope is
  scrubbed from the hosted PTY environment. No YAML and no CLI-owned files.

### Changed

- `TOKIMEKI_WINDOW` defaults to `tui` and selects commands from
  `TOKIMEKI_WINDOW_TUI`; `on` enables every host command and `off` restores the
  legacy raw/resize path. `TOKIMEKI_PTY_SIZE` still overrides
  `TOKIMEKI_WINDOW_SIZE`.
- Debug CLI logs no longer write directly over the TUI: while a viewport owns
  the screen they go to the log panel (debug) or an exit-time stderr replay
  (non-debug).

### Fixed

- Attaching a viewer no longer resizes the host PTY or redraws Claude/pi; all
  viewers share the same fixed logical grid.
- Terminal query responses are answered exactly once: by the host mirror when
  all viewers support the viewport, otherwise by a legacy viewer terminal.

## [0.1.1] - 2026-11-16

### Added

- Tag-triggered GitHub Actions release workflow: pushing `v<version>` runs the
  full verification gate, publishes `@limccn/tokimeki-protocol` before
  `@limccn/tokimeki` to npmjs and GitHub Packages, and creates a GitHub
  Release. `npm run release:bump` updates all package versions, exact internal
  dependencies, and the lockfile; `npm run release:check` verifies the tag,
  package versions, and lockfile agree.
- v1.1 F0 P2P transport enhancements: capability-gated `FRAGMENT 0x08`
  DataChannel fragmentation/reassembly, P2P-direct `SNAPSHOT`, automatic ICE
  credential refresh, and one bounded TURN-provider retry before relay fallback.
- v1.1 F2 read-only listener mode: `listener` is an active snapshot-only role;
  `tokimeki attach --listen` receives immediate and periodic full
  `SNAPSHOT_TO` snapshots without input, resize, ACK, resync, or P2P. The relay
  advertises `listener.modes: ["snapshot-only"]`, enforces
  `TOKIMEKI_MAX_LISTENERS` (default 8) on top of the total client cap, and
  excludes listeners from output/ACK/backpressure/slow-consumer accounting.
  Pre-v1.1 relays still reject listener with `not_implemented`.
- v1.1 F1 opt-in P2P-only TUN profile: `TOKIMEKI_TUNNEL=auto` negotiates a
  capability-gated `tunnel` envelope and runs AES-256-GCM records with HKDF
  direction keys plus selective-repeat ARQ over an unreliable/unordered
  DataChannel. Control messages, snapshots, resize, signaling, and relay ACK
  flow-control stay on the v1 paths; the relay continues to answer
  `TUNNEL`/`TUNNEL_TO` with `not_implemented`. A key-mode/dialect mismatch or
  tunnel failure falls back to the relay and requests a fresh snapshot.
  `TOKIMEKI_TUNNEL_SECRET` selects relay-blind `shared-secret` keys and is
  scrubbed from the hosted PTY environment/redacted from logs. XOR FEC is
  deferred to F1.1.
- v1.1 F1.1 XOR FEC for the TUN profile: `TOKIMEKI_TUNNEL_FEC=xor` emits one
  AEAD-authenticated parity record per full group of eight data records, and
  the receiver rebuilds exactly one missing record before falling back to ARQ.
  The capability advertises `fec: ["none", "xor"]`; the host offers `xor` only
  when the peer advertises it and otherwise keeps `none`. FEC is supplementary:
  lost parity, multiple losses, malformed records, or pruned recovery state
  never bypass AEAD and continue to rely on ARQ or relay fallback. The default
  `off` and `TOKIMEKI_TUNNEL=off` behaviors are unchanged.
- v1.1 F3 same-LAN ICE hint: selected candidate pairs whose local and remote
  addresses are loopback/private/link-local are logged as `lan=yes` (otherwise
  `lan=no`) for diagnostics only. Route selection, relay fallback, flow control,
  and security semantics are unchanged. mDNS is not adopted; peer fan-out
  remains design-only and default-off.
- Tunnel record layout/AAD golden vectors and a `tunnel` capability `keyMode`
  field in `@limccn/tokimeki-protocol`.
- Golden vectors and protocol/capability coverage for `FRAGMENT` and
  `transports.fragmentation`.
- 512×512 rounded PNG repository icon with transparent corners
  (`assets/icon.png`), generated from the new mascot artwork.

### Changed

- English and Chinese READMEs now reference `assets/icon.png` instead of the
  legacy `assets/icon.svg` header icon.
- Acceptance records now note that strict NAT↔NAT (including P2P attempts and
  relay fallback) and real Claude/pi TUI interaction were manually confirmed at
  the e2e layer on 2026-11-16. This is not a production, long-run,
  direct-path-success-rate, or exhaustive interaction acceptance claim.

## [0.1.0] - 2026-11-14

First public release.

### Added

- Cloudflare Worker + per-session Durable Object relay with WebSocket
  authentication, routing, snapshots, ACK-based flow control, and resync.
- `tokimeki` CLI: host `claude` / `pi` / arbitrary commands in a PTY, attach
  from another machine, and `doctor` diagnostics.
- WebRTC P2P transport with direct candidates, coturn TURN, Cloudflare
  Realtime TURN, and automatic Worker relay fallback.
- Multi-viewer shared control, resize policies, snapshot/reconnect, and
  sequence-aware output.
- Shared `@limccn/tokimeki-protocol` package with zod message schemas, binary
  frames, error/close codes, and golden fixtures.
- Cloudflare one-click relay deployment, TURN/STUN configuration docs, CLI
  usage docs, and English/Chinese READMEs.
- Apache-2.0 license and open-source contribution/security/conduct files.

### Known limitations

- P2P direct is best-effort; TURN or the Worker relay is the reliable path.
- At release time, strict NAT↔NAT validation, production edge hibernation/TTL
  long-run, and real Claude/pi TUI manual acceptance remained
  environment-dependent.
- v1 has no DataChannel fragmentation, automatic TURN provider refresh, or
  listener/tunnel runtime.
- Cross-NAT WAN flow-control pause/resume was not observed in the 2026-11-14
  tests; link-quality work (selective-repeat/ARQ) is planned for a later
  release.

> Post-release update (2026-11-16): strict NAT↔NAT and real Claude/pi TUI were
> manually confirmed at the e2e layer; see `docs/deployment.md` §7.6. v1.1
> added DataChannel fragmentation, listener snapshot-only mode, and an opt-in
> P2P-only AEAD/ARQ tunnel; F1.1 added opt-in XOR parity for single-loss
> recovery. The 0.1.0 limitation above is kept as the release-time record.

[Unreleased]: https://github.com/limccn/tokimeki/compare/v0.1.7...HEAD
[0.1.7]: https://github.com/limccn/tokimeki/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/limccn/tokimeki/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/limccn/tokimeki/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/limccn/tokimeki/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/limccn/tokimeki/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/limccn/tokimeki/releases/tag/v0.1.2
[0.1.1]: https://github.com/limccn/tokimeki/releases/tag/v0.1.1
[0.1.0]: https://github.com/limccn/tokimeki/releases/tag/v0.1.0
