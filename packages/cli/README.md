# tokimeki CLI

[![npm](https://img.shields.io/npm/v/@limccn/tokimeki.svg)](https://www.npmjs.com/package/@limccn/tokimeki)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/limccn/tokimeki/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](https://nodejs.org/)

Share a live TUI terminal (Claude Code, pi, or any PTY program) with another
machine through a Cloudflare relay, WebRTC P2P, or TURN.

```bash
npm install -g @limccn/tokimeki
tokimeki --help

# or without a global install
npx @limccn/tokimeki --help
```

## Quick start

```bash
# Host: start a TUI and print a session token
TOKIMEKI_RELAY_URL=wss://relay.example.com \
TOKIMEKI_MASTER_TOKEN=<relay-master-token> \
  tokimeki claude

# Viewer: attach from another machine
TOKIMEKI_RELAY_URL=wss://relay.example.com \
TOKIMEKI_SESSION=<session-name> \
TOKIMEKI_SESSION_TOKEN=<session-token> \
  tokimeki attach

# Check the local PTY and relay configuration
TOKIMEKI_RELAY_URL=wss://relay.example.com \
TOKIMEKI_MASTER_TOKEN=<relay-master-token> \
  tokimeki doctor
```

Full documentation: [github.com/limccn/tokimeki](https://github.com/limccn/tokimeki)
and [docs/cli.md](https://github.com/limccn/tokimeki/blob/main/docs/cli.md).

## License

Apache-2.0. See [LICENSE](https://github.com/limccn/tokimeki/blob/main/LICENSE).
