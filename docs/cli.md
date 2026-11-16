# tokimeki CLI

The `tokimeki` command hosts a TUI/PTY program on one machine and lets another
machine attach to the same live session.

## Install

Requirements: Node.js >= 22.12 and npm >= 11.

```bash
npm install -g @limccn/tokimeki
tokimeki --version
tokimeki --help
```

Windows uses ConPTY; macOS/Linux use the native PTY. The CLI terminal data path
uses `node-pty` and `node-datachannel` native modules.

## Commands

| Command | Description |
|---|---|
| `tokimeki claude [args...]` | Host the `claude` CLI in a PTY |
| `tokimeki pi [args...]` | Host the `pi` CLI in a PTY |
| `tokimeki run -- <cmd...>` | Host any command in a PTY (`--` protects flags) |
| `tokimeki attach` | Attach to a hosted session (shared control) |
| `tokimeki attach --listen` | Attach as a read-only snapshot-only listener (v1.1) |
| `tokimeki doctor` | Check config, PTY support, and relay reachability |

`claude`/`pi` arguments are passed through. `tokimeki claude --help` runs the
local `claude --help` without requiring relay configuration.

## Host a session

```bash
export TOKIMEKI_RELAY_URL=wss://relay.example.com
export TOKIMEKI_MASTER_TOKEN=<relay-master-token>

tokimeki claude
# or: tokimeki pi
# or: tokimeki run -- htop
```

On startup the host prints a banner:

```text
[tokimeki] session: <hostname>-<cwd-or-session>
[tokimeki] relay: wss://relay.example.com
[tokimeki] viewers: 0
[tokimeki] session token (generated, save it): <session-token>
```

If you set `TOKIMEKI_SESSION_TOKEN` yourself, the banner says it was provided
instead of printing the value. The host owns the PTY; closing the host or
pressing Ctrl-C in the hosted program ends the session.

Useful host variables:

| Variable | Default | Meaning |
|---|---|---|
| `TOKIMEKI_RELAY_URL` | — (required) | `wss://` relay endpoint |
| `TOKIMEKI_MASTER_TOKEN` | — (required) | Relay host secret; never share with viewers |
| `TOKIMEKI_SESSION` | sanitized hostname+cwd | Session name (ASCII/`._-`, <=64 chars) |
| `TOKIMEKI_SESSION_TOKEN` | generated | Per-session viewer token; generated value is printed once |
| `TOKIMEKI_P2P` | `auto` | `off` forces the Worker relay |
| `TOKIMEKI_ICE_TRANSPORT_POLICY` | `all` | `relay` restricts ICE to TURN (test/forced TURN) |
| `TOKIMEKI_RESIZE_POLICY` | `latest` | `latest`, `min`, or `pinned` |
| `TOKIMEKI_PTY_SIZE` | — | `<cols>x<rows>`, used with `pinned` |
| `TOKIMEKI_TERM` | `xterm-256color` | PTY TERM |
| `TOKIMEKI_COLORTERM` | `truecolor` | PTY COLORTERM |
| `TOKIMEKI_HEARTBEAT_SECONDS` | `25` | WebSocket heartbeat; `0` disables |
| `TOKIMEKI_SCROLLBACK_LINES` | `1000` | Headless screen scrollback |
| `TOKIMEKI_SNAPSHOT_MAX_BYTES` | `262144` | Snapshot size budget |
| `TOKIMEKI_LISTENER_SNAPSHOT_MS` | `1000` | Read-only listener snapshot interval (250–60000 ms) |
| `TOKIMEKI_TUNNEL` | `off` | `auto` runs the P2P-only AEAD/ARQ tunnel |
| `TOKIMEKI_TUNNEL_FEC` | `off` | `xor` is recognized but deferred; currently runs without FEC |
| `TOKIMEKI_TUNNEL_SECRET` | — | Optional >=16-byte shared secret for relay-blind tunnel keys |
| `TOKIMEKI_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |

## Attach from another machine

```bash
export TOKIMEKI_RELAY_URL=wss://relay.example.com
export TOKIMEKI_SESSION=<host-session-name>
export TOKIMEKI_SESSION_TOKEN=<session-token>

tokimeki attach
```

Attach needs `TOKIMEKI_SESSION` and `TOKIMEKI_SESSION_TOKEN`; it does **not**
need the relay master token. The viewer enters the alternate screen, applies
the current snapshot, and forwards keyboard input.

- **Disconnect/reconnect:** the host PTY stays alive; a reconnecting viewer
  requests a fresh snapshot.
- **Multiple viewers:** all viewers share control; resize follows
  `TOKIMEKI_RESIZE_POLICY`.
- **Exit:** Ctrl-C is forwarded to the hosted program; quitting the viewer
  restores the local terminal.
- **P2P:** with `TOKIMEKI_P2P=auto` the viewer may switch to a WebRTC
  DataChannel. Large P2P switch/resync snapshots use the DataChannel when both
  peers advertise `transports.fragmentation`; otherwise they stay on the relay
  `SNAPSHOT_TO` path.
- **ICE refresh/retry:** clients refresh ICE credentials before `iceExpiresAt`.
  If a not-yet-ready P2P attempt fails (~12 s), the host refreshes to the next
  usable TURN provider once and renegotiates; a second failure stays on relay.
- **TURN:** set `TOKIMEKI_ICE_TRANSPORT_POLICY=relay` to require TURN; with no
  usable TURN the attempt times out and falls back to the relay. The CLI only
  uses TURN over UDP (libjuice).

### Read-only listener (v1.1)

```bash
export TOKIMEKI_RELAY_URL=wss://relay.example.com
export TOKIMEKI_SESSION=<host-session-name>
export TOKIMEKI_SESSION_TOKEN=<session-token>

tokimeki attach --listen
```

`--listen` connects with the `listener` role instead of `viewer`:

- The host sends one full ANSI snapshot immediately and then every
  `TOKIMEKI_LISTENER_SNAPSHOT_MS` (default 1000 ms; 250–60000 ms).
- Local keyboard input is ignored. Ctrl-C stops only the local listener and is
  never written to the hosted PTY.
- The listener never sends input, resize, ACK, resync, or P2P signaling. It
  does not affect viewer flow control or PTY sizing and never attempts P2P.
- It receives only relay `SNAPSHOT_TO` (plus presence/host-exited); there is no
  incremental output in this version.
- If the relay predates v1.1 listener support, the CLI prints an actionable
  `not_implemented` error and exits non-zero instead of falling back to a
  shared-control viewer.
- Relay operators can cap concurrent listeners with
  `TOKIMEKI_MAX_LISTENERS` (default 8; listeners also count toward
  `TOKIMEKI_MAX_CLIENTS_PER_SESSION`).
- Mixed versions: a v1.1 relay with a pre-v1.1 host still delivers snapshots
  (the old host treats the listener as a viewer), but the old host may attempt
  P2P signaling that the relay rejects. Upgrade the host to v1.1 for clean
  listener handling.

## Doctor

```bash
TOKIMEKI_RELAY_URL=wss://relay.example.com \
TOKIMEKI_MASTER_TOKEN=<relay-master-token> \
  tokimeki doctor
```

`doctor` checks PTY spawn support, relay `/healthz`, and host authentication
configuration. It prints actionable warnings for missing/conflicting values.

## Exit codes

| Code | Meaning |
|---:|---|
| `0` | Success |
| `1` | Runtime/connection failure, a failed `doctor` check, or CLI usage error |
| `2` | Invalid `TOKIMEKI_*` configuration at host/attach startup |

## P2P / TURN / relay selection

1. `TOKIMEKI_P2P=off` — Worker relay only.
2. `auto` — attempt WebRTC per viewer; if a not-yet-ready attempt fails within
   ~12 s, refresh to the next usable TURN provider once and retry, then resume
   relay output and request a fresh snapshot.
3. `TOKIMEKI_ICE_TRANSPORT_POLICY=relay` — force TURN candidates for testing;
   no usable TURN means timeout + relay fallback.
4. Relay fallback is always available; control/signaling always use the relay.

## TUN profile (v1.1, opt-in)

`TOKIMEKI_TUNNEL=auto` adds an application-layer tunnel for terminal bytes on
top of an unreliable/unordered WebRTC DataChannel:

- The host creates the unordered DataChannel only after the viewer advertises
  the exact `tunnel` capability (`version:1`, `arq:"selective-repeat"`,
  `crypto:"aes-256-gcm"`, matching `keyMode`, `maxFrameSize:16339`).
- Records use AES-256-GCM with HKDF direction keys, selective-repeat ARQ
  (window 64), and a bounded retransmission budget. Control messages,
  snapshots, resize, signaling, and relay ACK flow-control stay on their
  existing v1 paths.
- `TOKIMEKI_TUNNEL=off` (default) keeps the v1 reliable DataChannel behavior.
  A tunnel mismatch or failure falls back to the relay and requests a fresh
  snapshot; the PTY/TUI session is not terminated.
- `keyMode` is `session-token` by default. The relay has seen the session
  token and can derive those keys, so this mode is transport hardening only,
  **not** end-to-end encryption. Setting `TOKIMEKI_TUNNEL_SECRET` switches to
  `shared-secret`; the relay cannot derive those keys, so only that mode may
  be described as relay-blind.
- `TOKIMEKI_TUNNEL_SECRET` must be shared out of band between host and viewer.
  It is scrubbed from the hosted PTY environment and redacted from logs. A
  missing secret on one end prevents negotiation (keyMode mismatch) and the
  session stays on the relay. If the values differ while both ends use
  `shared-secret`, the tunnel is negotiated but AEAD authentication fails;
  after the failure threshold it falls back to the relay and requests a fresh
  snapshot.
- XOR FEC is deferred: `TOKIMEKI_TUNNEL_FEC=xor` is accepted but logs a
  warning and runs without FEC (`fec: ["none"]` in the capability).
- The relay never forwards `TUNNEL` frames; it still returns
  `not_implemented`. TUN is P2P-only in this release.

Logs go to stderr and redact known tokens. Use `TOKIMEKI_LOG_LEVEL=debug` when
diagnosing connection issues.

## Troubleshooting

| Symptom | Check |
|---|---|
| `401 unauthorized` | `TOKIMEKI_MASTER_TOKEN` matches the relay secret; host/session tokens differ |
| `host_offline` | Host is connected to the same relay/session and still running |
| `session_full` | Increase the relay's `TOKIMEKI_MAX_CLIENTS_PER_SESSION` |
| P2P never opens | Corporate UDP firewall; try TURN or `TOKIMEKI_P2P=off` |
| Tunnel never activates | Both ends need `TOKIMEKI_TUNNEL=auto`, P2P enabled, and the same key mode (`TOKIMEKI_TUNNEL_SECRET` present on both or absent on both) |
| Tunnel falls back to relay | Check debug logs for `tunnel unavailable`; a wrong shared secret, high loss, or oversized frames cause fallback |
| TURN attempt takes ~12 s | Expected when TURN is unreachable; relay takes over |
| Garbled screen after reconnect | Enable `debug` logs and file an issue with the terminal/OS details |
| Local terminal not restored | Run `reset`; report the terminal emulator and OS |

Full relay/TURN deployment: [deploy-cloudflare.md](deploy-cloudflare.md).
All environment variables: [`.env.example`](../.env.example).

## Security

- The master token authenticates **hosts**; never give it to viewers.
- Session tokens are per session; share them over a trusted channel.
- Tokens are sent in headers, not URLs.
- The relay can see terminal bytes while carrying them. P2P/TURN change the
  transport path; this is not end-to-end encryption.
