#!/bin/sh
set -eu

export CODEX_HOME="$HOME/.codex"
if [ -f /root/.codex/auth.json ]; then
  :
elif [ -n "${CODEX_AUTH_JSON_B64:-}" ]; then
  mkdir -p "$CODEX_HOME"
  umask 077
  printf '%s' "$CODEX_AUTH_JSON_B64" | base64 -d > "$CODEX_HOME/auth.json"
  chmod 600 "$CODEX_HOME/auth.json"
elif [ -n "${OPENAI_API_KEY:-}" ]; then
  printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key
else
  echo 'Codex auth is missing. Supply auth.json, CODEX_AUTH_JSON_B64, or OPENAI_API_KEY.' >&2
  exit 1
fi
unset CODEX_AUTH_JSON_B64
git config --global --add safe.directory '*'
exec node /app/main.js
