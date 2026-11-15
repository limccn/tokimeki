#!/usr/bin/env bash
set -euo pipefail

# Strict-NAT viewer launcher for macOS/Linux.
# Usage: ./viewer-mac.sh <session> [direct|turn]
# The session token is read from TOKIMEKI_SESSION_TOKEN or prompted.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

SESSION="${1:-${TOKIMEKI_SESSION:-}}"
MODE="${2:-direct}"

if [ -z "$SESSION" ]; then
  read -r -p "Session name: " SESSION
fi
if [ -z "${TOKIMEKI_SESSION_TOKEN:-}" ]; then
  read -r -s -p "Session token: " TOKIMEKI_SESSION_TOKEN
  echo
fi
if [ -z "$SESSION" ] || [ -z "$TOKIMEKI_SESSION_TOKEN" ]; then
  echo "Session name and token are required" >&2
  exit 2
fi
if [ "$MODE" != "direct" ] && [ "$MODE" != "turn" ]; then
  echo "Mode must be direct or turn" >&2
  exit 2
fi

if [ ! -f packages/cli/dist/index.js ]; then
  echo "Building CLI..."
  npm ci
  npm run build
fi

export TOKIMEKI_SESSION="$SESSION"
export TOKIMEKI_SESSION_TOKEN
export TOKIMEKI_RELAY_URL="${TOKIMEKI_RELAY_URL:-wss://relay.tokiapi.app}"
export TOKIMEKI_P2P=auto
export TOKIMEKI_LOG_LEVEL=debug

exec node scripts/strictnat/viewer-runner.mjs \
  --mode "$MODE" \
  --bytes "${BYTES:-1048576}" \
  --label mac \
  2> "attach-mac-${MODE}.log"
