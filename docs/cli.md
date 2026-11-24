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
| `tokimeki codex\|gemini\|cursor\|aider\|opencode\|goose\|amp [args...]` | Host a catalog ACP command (v1.4; allow-listed by default) |
| `tokimeki run -- <cmd...>` | Host any command in a PTY (`--` protects flags) |
| `tokimeki attach [share-url]` | Attach to a hosted session (shared control) |
| `tokimeki attach --listen` | Attach as a read-only snapshot-only listener (v1.1) |
| `tokimeki doctor` | Check config, PTY support, and relay reachability |
| `tokimeki acp list [--detect]` | List the ACP catalog; `--detect` scans PATH read-only |
| `tokimeki history [list\|remove <session>\|clear]` | Inspect/clear saved connection history |

Global flags must appear before the command:

```bash
tokimeki --interactive claude     # force interactive onboarding (TTY required)
tokimeki --daemon attach          # force daemon/harness mode (no prompts)
tokimeki --config tokimeki-config.json claude
```

`claude`/`pi` arguments are passed through. `tokimeki claude --help` runs the
local `claude --help` without requiring relay configuration. Flags after a
hosted `claude`/`pi` command belong to that TUI; `tokimeki --config f claude`
reads the file, while `tokimeki claude --config f` passes it through.

## Modes and onboarding (v1.4, CLI >= 0.1.5)

- **interactive** (TTY default): doctor-first startup; missing relay/token
  configuration opens the host or attach wizard. `--interactive` forces it and
  exits 2 without a TTY.
- **daemon** (non-TTY default): no prompts, no stdin interaction. `--daemon` or
  `TOKIMEKI_MODE=daemon` forces it.
- Daemon events go to **stderr** as one-line JSON prefixed `tokimeki-event: `
  (`ready`/`status`/`error`/`report`, schema v1). stdout stays terminal bytes,
  or the doctor report. Do not merge stdout/stderr when parsing events. Events
  are not suppressed by `TOKIMEKI_LOG_LEVEL=silent` or the local viewport.
- Exit codes: `0` success, `1` runtime/connection, `2` configuration.
- `tokimeki acp list --detect` reports only “a same-named executable exists in
  PATH”; it never executes detected binaries, never edits `TOKIMEKI_WINDOW_TUI`,
  and never auto-hosts.

## Onboarding shortcuts (v1.4, CLI >= 0.1.5)

- `tokimeki --config <tokimeki-config.json> claude` hosts directly from a
  TokiAPI-downloaded v1/v2 envelope. `TOKIMEKI_CONFIG_FILE` is the equivalent
  env input for harnesses; `--config` wins with a warning. The file must be a
  regular, non-symlink file, ≤64 KiB, and 0600 on POSIX when it contains
  secrets. `--config` is host-only (claude/pi/run/ACP).
- `tokimeki attach https://tokiapi.app/#t-<code>` exchanges the invite through
  `POST /api/tokimeki/attach/cli` and attaches. `TOKIMEKI_ATTACH_URL` is the
  equivalent env input; the value `-` reads one line from stdin. The share URL
  is a capability secret; prefer env/stdin over argv.
- `TOKIMEKI_CONFIG_FILE` and `TOKIMEKI_ATTACH_URL` are removed from the hosted
  PTY environment along with the token/passcode/tunnel secrets.

## Host a session

There are two host credentials:

- `TOKIMEKI_TOKEN` — the normal credential: a TokiAPI **Host JWT** or a static
  **namespace token**. The CLI treats it as an opaque string (no parsing, no
  expiry checks) and always sends it on `X-Tokimeki-Token`. Requires
  `TOKIMEKI_NAMESPACE`.
- `TOKIMEKI_MASTER_TOKEN` — the **single-owner fallback credential**: one
  person exclusively owning a relay needs only this token. A relay with at
  least one valid `TOKIMEKI_NAMESPACE_TOKENS` entry rejects it (and root `*`
  takeover stops working), so prefer `TOKIMEKI_TOKEN` whenever the relay is
  shared.

```bash
export TOKIMEKI_RELAY_URL=wss://relay.example.com
export TOKIMEKI_MASTER_TOKEN=<relay-master-token>

tokimeki claude
# or: tokimeki pi
# or: tokimeki run -- htop
```

Shared relays use `TOKIMEKI_TOKEN` (namespace token or TokiAPI Host JWT) with a
required namespace. A host may only create sessions named `<namespace>.<slug>`;
the relay derives the namespace from the verified credential and rejects any
other prefix:

```bash
export TOKIMEKI_RELAY_URL=wss://relay.example.com
export TOKIMEKI_TOKEN=<team-a-host-token>   # namespace token or Host JWT
export TOKIMEKI_NAMESPACE=team-a

tokimeki claude
# session defaults to team-a.<hostname>-<cwd>; set TOKIMEKI_SESSION to override
```

`TOKIMEKI_NAMESPACE` and `TOKIMEKI_TOKEN` are a pair: both must be set
together, the CLI exits 2 if one is missing, and every generated command or
example names both. `TOKIMEKI_TOKEN` takes precedence over
`TOKIMEKI_MASTER_TOKEN` when both are set (with a warning); the token is never
written to disk, argv, URLs, or logs, and it is removed from the hosted PTY
environment like the other secrets. `TOKIMEKI_NAMESPACE_TOKEN` is **retired**:
a non-empty value exits 2 with a hint to rename it to `TOKIMEKI_TOKEN`.

The CLI can read `~/.tokimeki/config.json`
(`%USERPROFILE%\.tokimeki\config.json` on Windows): a flat JSON object of
`TOKIMEKI_*` keys with string/number/boolean values. Precedence is explicit
environment variables > `--config`/`TOKIMEKI_CONFIG_FILE` > `TOKIMEKI_CONFIG`
> config.json > defaults. Host credentials are selected per source layer, so a
stale credential in the file cannot shadow an explicit environment credential.

Since v1.4 (CLI >= 0.1.5) the onboarding wizard may **write** this file only
after the user explicitly confirms “save”: only
`TOKIMEKI_RELAY_URL`, `TOKIMEKI_NAMESPACE`, `TOKIMEKI_TOKEN`,
`TOKIMEKI_SESSION`, and `TOKIMEKI_SESSION_TOKEN` are written, with 0600
(POSIX), atomic replacement, no-follow, and a 0700 directory. It never writes
master/passcode/tunnel/TURN/JWT secrets, invite URLs, or `TOKIMEKI_MODE`; a
JWT-shaped session token is rejected. An existing file with insecure
permissions or invalid JSON is refused (never auto-chmodded). A separate
`~/.tokimeki/history.json` (0600, ≤20 entries) stores relay/session and, when
the user saves it, an opaque OSS session token; host tokens, passcodes, invite
URLs, and hosted Session JWTs are never written. `tokimeki history` lists
non-secret metadata, `history remove <session>` deletes one entry, and
`history clear` empties the file. Delete either file to fall back to env/
defaults.

On startup the host prints a banner:

```text
[tokimeki] session: <hostname>-<cwd-or-session>
[tokimeki] relay: wss://relay.example.com
[tokimeki] viewers: 0
[tokimeki] window: 120x40
[tokimeki] viewer config (secret, copy as one line): {"version":1,"relayUrl":"wss://relay.example.com","session":"...","sessionToken":"...","window":{"cols":120,"rows":40}}
[tokimeki] hint: press F12 to show this again
```

The viewer config line is the complete JSON envelope a viewer needs. Treat it
as a secret. The host owns the PTY; closing the host or pressing Ctrl-C in the
hosted program ends the session.

### Viewer config and the F12 connection menu

`TOKIMEKI_CONFIG` accepts a JSON object (no YAML). Fields map to the usual
`TOKIMEKI_*` variables; explicit environment variables win, and empty
environment placeholders do not erase config values.

```powershell
$env:TOKIMEKI_CONFIG='{"v":1,"relayUrl":"wss://relay.example.com","session":"demo","sessionToken":"...","window":{"cols":120,"rows":40}}'
tokimeki attach
```

In the host's full-screen viewport, press **F12** to open the connection menu
(v1.4; the old invite-only overlay is gone). The menu shows relay/namespace/
session, the viewer session token masked by default, viewer/listener counts,
transport/relay state, and the window size. Items:

1. Refresh status
2. Show/hide the session token
3. Copy the exact viewer config JSON (OSC 52)
4. Copy the anonymous-host invite URL (only when the host was started from the
   TokiAPI anonymous path; memory-only, never saved)
5. Open the log view (debug mode)
6. Resize the hosted window (host only; enters an arrow-key editor, Enter
   applies through the normal resize pipeline)

Viewers/listeners get status, show/hide token, copy viewer config,
reconnect/resync, and disconnect (local only). Listeners remain read-only and
send no input/ACK/resize. Host credentials (`TOKIMEKI_TOKEN`/master) are never
shown. Press `s` to toggle reveal, `c` to copy, digits to select, Esc to close;
menu bytes never reach the hosted PTY.

- `TOKIMEKI_INVITE_KEY` selects the menu key: `f12` (default), `ctrl-]`, or
  `off`. F11 toggles the log view even when the menu is off.
- The menu requires the full-screen viewport. Legacy `TOKIMEKI_WINDOW=off` and
  headless hosts only have the startup banner.
- `TOKIMEKI_CONFIG` and its mapped token fields are removed from the hosted PTY
  environment; the config is never written to disk or uploaded to the relay.

If the banner has scrolled away and the menu is disabled, there is no
protocol-only way to recover the token: it exists only in the host process and
terminal output. Set `TOKIMEKI_SESSION_TOKEN` explicitly if you need a stable,
externally supplied credential.

### Fixed TUI window

For commands listed in `TOKIMEKI_WINDOW_TUI` (default: the 9 ACP commands
`claude,pi,codex,gemini,cursor,aider,opencode,goose,amp`), the host creates one
session-level logical grid (`TOKIMEKI_WINDOW_SIZE`, default `120x40`). Viewer
`resize` messages and local terminal resizes no longer change the hosted PTY;
the TUI is not laid out again when someone attaches. The F12 host menu can
resize the window for the session (fixed windows update an in-memory pinned
size; `latest`/`min` follow their normal policy).

The local terminal is split into:

```text
TUI viewport        (letterboxed when larger, cursor-following crop when smaller)
corner log area     (debug only, wide terminals >=120 cols: 40x8 bottom-right)
status bar          (always the bottom row; no token)
```

Narrow debug terminals no longer reserve a bottom panel: press **F11** (or the
F12 menu item) for a full-screen, scrollable log view; F11/Esc returns. The
viewport stays L-shaped on wide terminals and the camera is computed over the
merged top+corner rectangle. Hysteresis switches layouts at 120/118 columns.
`TOKIMEKI_LOG_VIEW_ROWS` sets the ring/view capacity (default 200, max 2000,
`0` disables); `TOKIMEKI_LOG_PANEL_ROWS` is deprecated and only acts as a
fallback capacity when the new key is unset.

`TOKIMEKI_WINDOW=off` restores the legacy raw/resize behavior. A headless host
(stdout not a TTY) still keeps the PTY fixed; it just does not draw a local
viewport.

### Other TUI commands

`TOKIMEKI_WINDOW_TUI` is also the dynamic subcommand allow-list:

```bash
export TOKIMEKI_WINDOW_TUI=claude,pi,omp
tokimeki omp
# equivalent: tokimeki run -- omp
```

Matching is by executable basename (case-insensitive; Windows `.exe/.cmd`
suffixes are ignored). Unknown commands that are not listed are rejected with a
usage error, so a typo never spawns anything implicitly. `claude`, `pi`, `run`,
`attach`, `doctor`, and `help` always keep their built-in meaning, even if they
appear in the list. `--help`/`-h`/`--version` for a listed command runs locally
without relay configuration.

Useful host variables:

| Variable | Default | Meaning |
|---|---|---|
| `TOKIMEKI_RELAY_URL` | — (required) | `wss://` relay endpoint |
| `TOKIMEKI_TOKEN` | — | Opaque host credential: TokiAPI Host JWT or static namespace token; requires `TOKIMEKI_NAMESPACE`; takes precedence over `TOKIMEKI_MASTER_TOKEN` |
| `TOKIMEKI_NAMESPACE` | — | Namespace name (`^[a-z0-9][a-z0-9_-]{0,31}$`), required with `TOKIMEKI_TOKEN` |
| `TOKIMEKI_MASTER_TOKEN` | — | Single-owner fallback credential (one person owning a relay); rejected once the relay has valid namespace tokens |
| `TOKIMEKI_SESSION` | `<namespace>.<hostname>-<cwd>` or sanitized hostname+cwd | Session name (ASCII/`._-`, <=64 chars); token mode auto-prefixes `<namespace>.` |
| `TOKIMEKI_SESSION_TOKEN` | generated | Per-session viewer token; generated value is printed once. Viewers may also receive a TokiAPI Session JWT (opaque to the CLI) |
| `TOKIMEKI_PASSCODE` | — | Optional per-session passcode (6..128 visible ASCII chars; letters/digits/`. _ ~ @ # * + = : -`). Host sends only a PBKDF2 verifier; viewers send `X-Tokimeki-Passcode`. Not the TokiAPI session token (6–8 digits) |
| `TOKIMEKI_P2P` | `auto` | `off` forces the Worker relay |
| `TOKIMEKI_ICE_TRANSPORT_POLICY` | `all` | `relay` restricts ICE to TURN (test/forced TURN) |
| `TOKIMEKI_RESIZE_POLICY` | `latest` | `latest`, `min`, or `pinned`; ignored when the fixed TUI window is active |
| `TOKIMEKI_PTY_SIZE` | — | `<cols>x<rows>`; overrides `TOKIMEKI_WINDOW_SIZE` when set |
| `TOKIMEKI_WINDOW` | `tui` | `tui`: use `TOKIMEKI_WINDOW_TUI`; `on`: every host command; `off`: legacy raw/resize behavior |
| `TOKIMEKI_WINDOW_TUI` | 9 ACP commands | Comma-separated command basenames that use the fixed TUI window and dynamic dispatch (`claude,pi,codex,gemini,cursor,aider,opencode,goose,amp` by default); an explicit list replaces the default |
| `TOKIMEKI_WINDOW_SIZE` | `120x40` | Fixed logical TUI window; viewers cannot change it; the F12 host menu can resize it for the session |
| `TOKIMEKI_LOG_VIEW_ROWS` | `200` | Debug log-ring/view capacity (max 2000; `0` disables the corner area and F11 view) |
| `TOKIMEKI_LOG_PANEL_ROWS` | — | **Deprecated.** Parsed only as a fallback capacity when `TOKIMEKI_LOG_VIEW_ROWS` is unset; no longer affects layout (v1.4) |
| `TOKIMEKI_INVITE_KEY` | `f12` | Local connection-menu key: `f12`, `ctrl-]`, or `off`; F11 log view stays available |
| `TOKIMEKI_MODE` | — | `interactive` or `daemon`; top-level `--interactive`/`--daemon` override it; non-TTY defaults to daemon |
| `TOKIMEKI_CONFIG_FILE` | — | Envelope file layer for host commands (same as `--config`); host-only |
| `TOKIMEKI_ATTACH_URL` | — | Share URL input for `tokimeki attach`; `-` reads one line from stdin |
| `TOKIMEKI_TOKIAPI_URL` | `https://tokiapi.app` | TokiAPI provider base override for local/test harnesses; https or loopback http only |
| `TOKIMEKI_CONFIG` | — | Optional JSON config envelope; maps fields to `TOKIMEKI_*` variables; explicit env > `--config` file > this string > `~/.tokimeki/config.json`; JSON only |
| `TOKIMEKI_TERM` | `xterm-256color` | PTY TERM |
| `TOKIMEKI_COLORTERM` | `truecolor` | PTY COLORTERM |
| `TOKIMEKI_HEARTBEAT_SECONDS` | `25` | WebSocket heartbeat; `0` disables |
| `TOKIMEKI_SCROLLBACK_LINES` | `1000` | Headless screen scrollback |
| `TOKIMEKI_SNAPSHOT_MAX_BYTES` | `262144` | Snapshot size budget |
| `TOKIMEKI_LISTENER_SNAPSHOT_MS` | `1000` | Read-only listener snapshot interval (250–60000 ms) |
| `TOKIMEKI_TUNNEL` | `off` | `auto` runs the P2P-only AEAD/ARQ tunnel |
| `TOKIMEKI_TUNNEL_FEC` | `off` | `xor` emits AEAD parity for single-loss recovery |
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

Interactive first-time attach (v1.4, CLI >= 0.1.5) runs doctor first, then the
attach wizard: paste a TokiAPI invite URL/code, paste a v1/v2 viewer config
JSON, restore a saved history entry, or enter relay/session/token manually.
The connection test reuses the real attach connection; a pre-ready failure
returns to the wizard without leaving raw mode/alternate screen behind. Hosted
Session JWTs and invite codes stay in memory and are never written to
config/history.

Share URL form:

```bash
tokimeki attach "https://tokiapi.app/#t-<code>"
# equivalent: TOKIMEKI_ATTACH_URL='https://...#t-<code>' tokimeki attach
# stdin (no shell history): echo '<url>' | tokimeki attach -
```

The URL origin is the TokiAPI provider; the returned `tokimekiRelayUrl` must be
wss and bound to that origin, otherwise the CLI refuses the exchange. 410
(invalid/expired), 429 (Retry-After), 503 (not configured), and a required
passcode are reported without automatic retry storms. `mode=listener` attaches
as a listener automatically; a viewer invite combined with `--listen` exits 2.

`TOKIMEKI_SESSION_TOKEN` may be either the host's opaque session token or a
TokiAPI **Session JWT** issued by an invite (`POST /api/tokimeki/attach/cli`).
The CLI treats both as opaque values; the relay verifies the JWT and skips the
opaque hash comparison. If the host set `TOKIMEKI_PASSCODE`, viewers must also
set it (sent as `X-Tokimeki-Passcode`); wrong passcodes lock verification for
30 seconds after five failures.

- **Config envelope:** the host's `viewer config` JSON can be passed as
  `TOKIMEKI_CONFIG` instead of setting `TOKIMEKI_RELAY_URL`,
  `TOKIMEKI_SESSION`, and `TOKIMEKI_SESSION_TOKEN` separately.
- **Disconnect/reconnect:** the host PTY stays alive; a reconnecting viewer
  requests a fresh snapshot.
- **Multiple viewers:** all viewers share control. With a fixed TUI window,
  attaching or resizing a viewer never changes the host PTY; each viewer only
  changes its own local viewport.
- **Fixed window discovery:** the viewer reads the host's
  `capabilities.display.fixed` from `welcome.clients`. If present, it renders
  the fixed grid through a local mirror with a bottom status bar (and a debug
  log panel when enabled). Old hosts or old relays without that metadata fall
  back to legacy raw rendering and the existing resize policy.
- **Small terminals:** the viewport letterboxes the grid when the local
  terminal is larger, and crops with cursor-following when it is smaller.
  Mouse clicks are mapped from local coordinates into the logical grid.
- **Exit:** Ctrl-C is forwarded to the hosted program; quitting the viewer
  restores the local terminal.
- **P2P:** with `TOKIMEKI_P2P=auto` the viewer may switch to a WebRTC
  DataChannel. Large P2P switch/resync snapshots use the DataChannel when both
  peers advertise `transports.fragmentation`; otherwise they stay on the relay
  `SNAPSHOT_TO` path.
- **ICE refresh/retry:** clients refresh ICE credentials before `iceExpiresAt`.
  If a not-yet-ready P2P attempt fails (~12 s), the host refreshes to the next
  usable TURN provider once and renegotiates; a second failure stays on relay.
- **LAN hint:** when both selected ICE candidates are loopback/private/link-local,
  P2P debug logs include `lan=yes` (otherwise `lan=no`). The hint is diagnostic
  only and does not change candidate selection or relay fallback.
- **Adjacent-network optimization:** mDNS and peer fan-out are not implemented;
  peer fan-out remains a design-only, default-off future item.
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
TOKIMEKI_TOKEN=<host-token-or-jwt> \
TOKIMEKI_NAMESPACE=team-a \
  tokimeki doctor
```

`doctor` checks PTY spawn support, relay `/healthz`, config-file state, and
host authentication configuration. It recognizes `TOKIMEKI_TOKEN`
(preferred) and `TOKIMEKI_MASTER_TOKEN` (single-owner fallback) plus
`TOKIMEKI_NAMESPACE`, and warns about missing or conflicting values without
printing tokens. It probes the authenticated `/auth/whoami` endpoint with the
effective credential on `X-Tokimeki-Token` and echoes only the response's
`authMode` (`jwt`/`namespace`/`master`) and safe fields (namespace, token_use,
scopes, expiry, TURN provider); a mismatch between the whoami namespace and
`TOKIMEKI_NAMESPACE` produces a warning. Older relays without whoami, or a
relay where the credential is rejected (for example the fallback token after
namespace tokens were enabled), produce a warning with migration hints — not a
failure. Structural problems (invalid config JSON, bad permissions, the
retired `TOKIMEKI_NAMESPACE_TOKEN` key) still exit 2 before doctor runs.

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
- `TOKIMEKI_TUNNEL_FEC=xor` (default `off`) emits one AEAD parity record per
  full group of eight data records. The receiver can rebuild exactly one lost
  record; lost parity or multiple losses stay on ARQ. Both peers advertise
  `fec: ["none", "xor"]`; the host offers `xor` only when the peer advertises
  it, otherwise the link keeps the plain F1 dialect. Incoming parity is always
  understood, even when the local sender policy is `off`. FEC does not change
  the ARQ/relay fallback guarantees.
- The relay never forwards `TUNNEL` frames; it still returns
  `not_implemented`. TUN is P2P-only in this release.

Logs redact known tokens. When a fixed viewport owns the screen,
`TOKIMEKI_LOG_LEVEL=debug` routes logs to the 40x8 corner area on wide
terminals (≥120 cols) and to the F11 full-screen view on narrow terminals
(`TOKIMEKI_LOG_VIEW_ROWS`, default 200); non-debug logs are buffered and
written back to stderr after the viewport exits. Control characters are
stripped at the render boundary. Legacy/non-TTY sessions keep the existing
stderr behavior.

## Troubleshooting

| Symptom | Check |
|---|---|
| `401 unauthorized` | Host credential matches the relay (master or namespace token), the session prefix is `<namespace>.<slug>` in namespace mode, and host/session tokens differ |
| `host_offline` | Host is connected to the same relay/session and still running |
| `session_full` | Increase the relay's `TOKIMEKI_MAX_CLIENTS_PER_SESSION` |
| Viewer shows only part of the TUI | Local terminal is smaller than `TOKIMEKI_WINDOW_SIZE`; enlarge it or set a smaller fixed size at host start. The status bar shows `view:WxH@x,y` and the camera follows the TUI cursor |
| F12 does not open the connection menu | The menu needs the full-screen host viewport (`TOKIMEKI_WINDOW=off` and headless hosts do not have it). Try `TOKIMEKI_INVITE_KEY=ctrl-]` if the terminal intercepts F12 |
| F11 does not open the log view | The terminal may intercept F11; the debug F12 menu's “Open log view” item is the fallback. Set `TOKIMEKI_LOG_VIEW_ROWS>0` and `TOKIMEKI_LOG_LEVEL=debug` |
| `TOKIMEKI_CONFIG` is ignored | It must be valid JSON; precedence is explicit env > `--config` file > `TOKIMEKI_CONFIG` > config.json |
| `--config` says “host commands only” | `--config`/`TOKIMEKI_CONFIG_FILE` are host-only; use `tokimeki attach <share-url>` or the attach wizard |
| `--config sets TOKIMEKI_RELAY_URL without a host credential` | A partial config file would send another layer's token to the file's relay; put the token in the same file or set relay+credential in explicit env |
| attach share URL returns 401/410/429/503 | Session JWT expired/invalid (410), rate limited (429, back off), provider disabled (503); exchange again rather than looping |
| Fixed window never activates | Relay must echo `capabilities` in `welcome.clients`; upgrade/redeploy the relay. Old relays fall back to legacy rendering |
| `tokimeki omp` says unknown command | Add `omp` to `TOKIMEKI_WINDOW_TUI` or use `tokimeki run -- omp` |
| P2P never opens | Corporate UDP firewall; try TURN or `TOKIMEKI_P2P=off` |
| Tunnel never activates | Both ends need `TOKIMEKI_TUNNEL=auto`, P2P enabled, and the same key mode (`TOKIMEKI_TUNNEL_SECRET` present on both or absent on both) |
| Tunnel falls back to relay | Check debug logs for `tunnel unavailable`; a wrong shared secret, high loss, or oversized frames cause fallback |
| TURN attempt takes ~12 s | Expected when TURN is unreachable; relay takes over |
| Garbled screen after reconnect | Enable `debug` logs and file an issue with the terminal/OS details |
| Local terminal not restored | Run `reset`; report the terminal emulator and OS |

Full relay/TURN deployment: [deploy-cloudflare.md](deploy-cloudflare.md).
All environment variables: [`.env.example`](../.env.example).

## Security

- Host credentials (`TOKIMEKI_TOKEN`, `TOKIMEKI_MASTER_TOKEN`) authenticate
  **hosts**; never give them to viewers. `TOKIMEKI_MASTER_TOKEN` is the
  single-owner fallback credential and stops working once the relay enables
  namespace tokens.
- Session tokens are per session; share them over a trusted channel.
- Tokens are sent in headers, not URLs; the CLI never sends `Authorization`
  (that carrier belongs to web/proxy Host JWT attach).
- A leaked `TOKIMEKI_TOKEN` is valid until expiry: Host JWTs live up to 30
  days with no revocation, and a static namespace token is a shared namespace
  credential — rotate the value in TokiAPI (or in `TOKIMEKI_NAMESPACE_TOKENS`)
  and restart hosts after a leak.
- The relay can see terminal bytes while carrying them. P2P/TURN change the
  transport path; this is not end-to-end encryption.
