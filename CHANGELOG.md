# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
  deferred; the capability advertises `fec: ["none"]`.
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
> P2P-only AEAD/ARQ tunnel (XOR FEC deferred). The 0.1.0 limitation above is
> kept as the release-time record.

[Unreleased]: https://github.com/limccn/tokimeki/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/limccn/tokimeki/releases/tag/v0.1.0
