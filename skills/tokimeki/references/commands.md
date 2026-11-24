# tokimeki commands and environment

## Commands (tokimeki >= 0.1.5 unless noted)

```bash
tokimeki claude [args...]
tokimeki pi [args...]
tokimeki codex|gemini|cursor|aider|opencode|goose|amp [args...]
tokimeki run -- <command> [args...]
tokimeki attach [share-url] [--listen]
tokimeki doctor
tokimeki acp list [--detect]
tokimeki history [list|remove <session>|clear]
```

Global flags must appear before the command:

```bash
tokimeki --interactive claude     # force interactive onboarding (TTY)
tokimeki --daemon attach          # force daemon/harness mode
tokimeki --config tokimeki-config.json claude
```

`--interactive`/`--daemon`/`--config` after `claude`/`pi` belong to the hosted
TUI and are passed through unchanged.

Daemon mode writes one-line JSON events to **stderr** with the prefix
`tokimeki-event: ` (ready/status/error/report); stdout stays terminal bytes or
the doctor report. Do not merge stdout and stderr when parsing events.

## Environment

Runtime configuration is environment-driven. Precedence:

```text
explicit TOKIMEKI_* env
  > --config <file> / TOKIMEKI_CONFIG_FILE
  > TOKIMEKI_CONFIG (JSON envelope)
  > ~/.tokimeki/config.json
  > defaults
```

| Variable | Purpose |
|---|---|
| `TOKIMEKI_RELAY_URL` | Relay base URL (`wss://`; `ws://` loopback only) |
| `TOKIMEKI_TOKEN` | Host credential: Host JWT or static namespace token (recommended) |
| `TOKIMEKI_NAMESPACE` | Namespace for `TOKIMEKI_TOKEN`; sessions must be `<namespace>.<slug>` |
| `TOKIMEKI_MASTER_TOKEN` | Deprecated single-owner fallback alias |
| `TOKIMEKI_SESSION` | Session name (`<namespace>.<slug>` for namespace hosts) |
| `TOKIMEKI_SESSION_TOKEN` | Viewer credential; host-generated if unset |
| `TOKIMEKI_PASSCODE` | Optional session passcode (hosted relay) |
| `TOKIMEKI_MODE` | `interactive` or `daemon` (flags override) |
| `TOKIMEKI_CONFIG_FILE` | Envelope file for host commands (same as `--config`) |
| `TOKIMEKI_ATTACH_URL` | Share URL for `tokimeki attach`; `-` reads stdin |
| `TOKIMEKI_WINDOW`, `TOKIMEKI_WINDOW_SIZE`, `TOKIMEKI_WINDOW_TUI` | Fixed TUI window / allow-list |
| `TOKIMEKI_LOG_LEVEL` | debug/info/warn/error/silent |
| `TOKIMEKI_INVITE_KEY` | `f12`, `ctrl-]`, or `off` (local connection menu) |
| `TOKIMEKI_RESIZE_POLICY` | `latest`, `min`, `pinned` |
| `TOKIMEKI_TUNNEL`, `TOKIMEKI_TUNNEL_FEC`, `TOKIMEKI_TUNNEL_SECRET` | Opt-in P2P TUN profile |

Never put tokens in argv or URLs. `tokimeki --config` and
`TOKIMEKI_CONFIG_FILE` take a file path, not a secret; the file itself must be
0600 on POSIX.

## Files

- `~/.tokimeki/config.json` — optional, wizard-written subset of
  `TOKIMEKI_*` keys; 0600, atomic write.
- `~/.tokimeki/history.json` — up to 20 saved connections (relay/session, and
  an opaque OSS session token when the user saves it); 0600. Host tokens,
  passcodes, invite URLs, and hosted Session JWTs are never written.
- `--config tokimeki-config.json` — TokiAPI-downloaded v1/v2 envelope; read
  only, never rewritten.

Delete either file to return to environment/default configuration.
