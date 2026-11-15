#!/usr/bin/env bash
set -euo pipefail

# Strict-NAT viewer using the published GitHub Packages CLI.
# Usage: ./viewer-github-mac.sh <session> [direct|turn]
#
# Requires a GitHub token with read:packages. The token is passed via
# GITHUB_TOKEN and referenced from a local .npmrc; it is not written there.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="${TOKIMEKI_VIEWER_DIR:-$HOME/.tokimeki-strictnat-viewer}"
SESSION="${1:-${TOKIMEKI_SESSION:-}}"
MODE="${2:-direct}"

if [ -z "$SESSION" ]; then
  read -r -p "Session name: " SESSION
fi
if [ -z "${TOKIMEKI_SESSION_TOKEN:-}" ]; then
  read -r -s -p "Session token: " TOKIMEKI_SESSION_TOKEN
  echo
fi
if [ -z "${GITHUB_TOKEN:-}" ]; then
  read -r -s -p "GitHub token (read:packages): " GITHUB_TOKEN
  echo
fi
if [ -z "$SESSION" ] || [ -z "$TOKIMEKI_SESSION_TOKEN" ] || [ -z "$GITHUB_TOKEN" ]; then
  echo "Session name, session token, and GitHub token are required" >&2
  exit 2
fi
if [ "$MODE" != "direct" ] && [ "$MODE" != "turn" ]; then
  echo "Mode must be direct or turn" >&2
  exit 2
fi

mkdir -p "$WORK_DIR"
chmod 700 "$WORK_DIR" 2>/dev/null || true
printf '%s\n' \
  "@limccn:registry=https://npm.pkg.github.com" \
  "//npm.pkg.github.com/:_authToken=\${GITHUB_TOKEN}" \
  > "$WORK_DIR/.npmrc"

echo "Installing @limccn/tokimeki from GitHub Packages..."
(
  cd "$WORK_DIR"
  npm install --no-save --no-audit --no-fund @limccn/tokimeki
)

export TOKIMEKI_VIEWER_WORKDIR="$WORK_DIR"
export TOKIMEKI_VIEWER_CLI="$WORK_DIR/node_modules/@limccn/tokimeki/dist/index.js"
export TOKIMEKI_SESSION="$SESSION"
export TOKIMEKI_SESSION_TOKEN
export TOKIMEKI_RELAY_URL="${TOKIMEKI_RELAY_URL:-wss://relay.tokiapi.app}"
export TOKIMEKI_P2P=auto
export TOKIMEKI_LOG_LEVEL=debug

exec node "$SCRIPT_DIR/viewer-runner.mjs" \
  --mode "$MODE" \
  --bytes "${BYTES:-1048576}" \
  --label github-mac \
  2> "attach-github-mac-${MODE}.log"
