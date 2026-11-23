#!/usr/bin/env bash
set -euo pipefail
set +x

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
work="$here/.work"
checkout="$work/ReviewBench"
args=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --pr|--set)
      [ "$#" -ge 2 ] || { echo "$1 needs a value." >&2; exit 2; }
      args+=("$1" "$2"); shift 2 ;;
    -e)
      [ "$#" -ge 2 ] || { echo '-e needs an environment variable.' >&2; exit 2; }
      variable="${2%%=*}"
      [[ "$variable" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo 'Invalid environment variable.' >&2; exit 2; }
      if [[ "$2" == *=* ]]; then export "${2?}"; else export "${variable?}"; fi
      args+=(-e "$variable"); shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

export RB_CONFIG_PRESET="${RB_CONFIG_PRESET:-standard}"
export RB_CONFIG_MODEL="${RB_CONFIG_MODEL:-gpt-6.1-terra}"
case "$RB_CONFIG_PRESET" in quick|standard|deep) ;; *) echo 'Invalid preset.' >&2; exit 2 ;; esac
mkdir -p "$work"
export npm_config_cache="$work/npm-cache"
if [ ! -d "$checkout/.git" ]; then
  git clone https://github.com/review-bench/ReviewBench.git "$checkout"
fi
(cd "$checkout" && npm ci)
docker build --platform linux/amd64 -f "$here/Dockerfile" -t talyn-review-bench:dev "$root"

CODEX_AUTH_JSON_B64="$(node --input-type=commonjs - "$HOME/.codex/auth.json" <<'NODE'
const fs = require('node:fs');
try {
  const text = fs.readFileSync(process.argv[2], 'utf8');
  const refreshed = Date.parse(JSON.parse(text).last_refresh);
  const age = Date.now() - refreshed;
  if (!Number.isFinite(age) || age < 0 || age >= 7 * 24 * 60 * 60 * 1000) throw new Error('stale');
  process.stdout.write(Buffer.from(text).toString('base64'));
} catch {
  console.error('Codex auth is missing or older than 7 days. Codex refreshes it after about 8 days; run `codex login` to get a fresh token.');
  console.error('A container refresh could rotate the token and log the host out.');
  process.exit(1);
}
NODE
)"
export CODEX_AUTH_JSON_B64

for variable in RB_CONFIG_PRESET RB_CONFIG_MODEL RB_CONFIG_JUDGE_MODEL RB_CONFIG_EFFORT RB_CONFIG_CONCURRENCY RB_CONFIG_UNIT_TIMEOUT_SEC RB_MODEL_BASE_URL; do
  if [ "${!variable+x}" = x ]; then
    export "${variable?}"
    args+=(-e "$variable")
  fi
done
mkdir -p "$work/runs"
run="$(mktemp -d "$work/runs/$RB_CONFIG_PRESET-$(date -u +%Y%m%d-%H%M%S)-XXXXXX")"
echo "Run directory: $run"
cd "$run"
export TRY_AGENT_WORK="$run/.try-agent"
"$checkout/scripts/try-agent.sh" talyn-review-bench:dev -e CODEX_AUTH_JSON_B64 "${args[@]}"
