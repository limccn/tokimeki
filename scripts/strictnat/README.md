# Strict NAT test scripts

Three-machine setup:

- **Host**: this local Windows machine (behind home NAT), runs `tokimeki run`.
- **Viewer A**: Mac on home broadband (behind NAT).
- **Viewer B**: Windows VPS behind a NAT gateway.

The relay stays on Cloudflare (`wss://relay.tokiapi.app`). The host master token
never leaves the host; viewers only receive a test session name + token.

## 1. Get the scripts on each machine

Host already has this repo. On the Mac and Windows VPS you have two options:

**A. Repo build** — clone the repo; the scripts build `packages/cli/dist` on
first run if it is missing.

```bash
git clone https://github.com/limccn/tokimeki.git
cd tokimeki
```

**B. GitHub Packages** — copy only `scripts/strictnat/`; no repo/build is
needed. Use the `viewer-github-*` scripts in section 3 and a GitHub PAT with
`read:packages`.

## 2. Start the host

Open **cmd.exe** on the host (not PowerShell), from the repo root:

```bat
scripts\strictnat\host-windows.cmd mac direct
```

or for the Windows viewer:

```bat
scripts\strictnat\host-windows.cmd win direct
```

or forced TURN:

```bat
scripts\strictnat\host-windows.cmd mac turn
scripts\strictnat\host-windows.cmd win turn
```

The script prints:

```text
Session: strictnat-local-mac-direct-<timestamp>
Token:   <test-only session token>
```

Keep this cmd window open. It reads the relay master token from
`%USERPROFILE%\.tokimeki\master-token` (or `TOKIMEKI_MASTER_TOKEN` if set).
It writes `host-<viewer>-<mode>-<timestamp>.log`.

## 3. Run the viewer

### Mac

```bash
chmod +x scripts/strictnat/viewer-mac.sh
./scripts/strictnat/viewer-mac.sh <session> direct
# forced TURN: ./scripts/strictnat/viewer-mac.sh <session> turn
```

The script prompts for the session token (input hidden), starts `attach` in a
PTY, sends `rtt` + `start 1048576`, prints `VIEWER_RESULT`, and exits.
It writes `attach-mac-<mode>.log`.

### Windows VPS (cmd.exe)

```bat
scripts\strictnat\viewer-windows.cmd direct <session>
rem forced TURN:
scripts\strictnat\viewer-windows.cmd turn <session>
```

The script prompts for the session token, runs the same viewer runner, prints
`VIEWER_RESULT`, and writes `attach-win-<mode>.log`.

### Option B: GitHub Packages viewer (no repo build)

If you do not want to clone/build on Mac/Windows, copy only the
`scripts/strictnat/` folder to the viewer machine and use the published
`@limccn/tokimeki@0.1.3` package from GitHub Packages.

Requirements: GitHub PAT with `read:packages`. The script installs the CLI into
`~/.tokimeki-strictnat-viewer` (or `%USERPROFILE%\.tokimeki-strictnat-viewer`),
prompts for the GitHub token and session token, and runs the same runner.

Mac:

```bash
chmod +x scripts/strictnat/viewer-github-mac.sh
./scripts/strictnat/viewer-github-mac.sh <session> direct
# forced TURN:
./scripts/strictnat/viewer-github-mac.sh <session> turn
```

Windows VPS (cmd.exe):

```bat
scripts\strictnat\viewer-github-windows.cmd direct <session>
rem forced TURN:
scripts\strictnat\viewer-github-windows.cmd turn <session>
```

The GitHub token is referenced from a local `.npmrc` via `${GITHUB_TOKEN}`,
not written into the file. Logs are `attach-github-mac-<mode>.log` /
`attach-github-win-<mode>.log`.

## 4. Test matrix

| Host session | Viewer | mode | Expected |
|---|---|---|---|
| `strictnat-local-mac-direct-*` | Mac | direct | `p2p-direct` or fallback |
| `strictnat-local-win-direct-*` | Windows | direct | `p2p-direct` or fallback |
| `strictnat-local-mac-turn-*` | Mac | turn | `p2p-turn, relay->relay` |
| `strictnat-local-win-turn-*` | Windows | turn | `p2p-turn, relay->relay` |

Strict NAT result: direct attempts may time out (~12 s) and fall back to relay;
forced TURN should still establish `p2p-turn`. Record the host log lines and
`VIEWER_RESULT` for each row.

## 5. What to inspect

Host (cmd):

```bat
findstr /i "viewer joined p2p ice provider using relay" host-<viewer>-<mode>-*.log
```

Mac viewer:

```bash
grep -E "route selector|p2p|transport|relay ready" attach-mac-<mode>.log
```

Windows viewer:

```bat
findstr /i "route selector p2p transport relay ready" attach-win-<mode>.log
```

The host log is authoritative for the final transport; the viewer log shows
negotiation and fallback messages.

## 6. Security

- `TOKIMEKI_MASTER_TOKEN` is only used by the host. Never set it on a viewer
  or paste it into chat/logs.
- The host generates a random test-only session token. It is printed to the
  host console so you can paste it into the viewer prompt; do not commit it.
- `.log` files may contain session IDs and terminal output; review/redact
  before sharing.
- Clear the host environment when finished (close the cmd window or
  `set "TOKIMEKI_MASTER_TOKEN="`).
- These scripts do not publish packages, deploy Workers, or call Cloudflare
  APIs.

## 7. Prerequisites

- Node.js >= 22.12, npm >= 11, git on all three machines.
- Host: `%USERPROFILE%\.tokimeki\master-token` (or `TOKIMEKI_MASTER_TOKEN`).
- Viewers can reach `wss://relay.tokiapi.app` and UDP TURN/STUN
  (`stun.tokiapi.app:3478`).
- Windows uses **cmd.exe**; the scripts are `.cmd` files. Mac uses bash.
