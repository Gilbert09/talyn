/** Prepare the guest's Codex config before its command starts. */
export function codexProviderPrelude(): string {
  return String.raw`if [ -z "${'${OPENAI_API_KEY+x}'}" ]; then
  export OPENAI_API_KEY=not-a-key-the-fleet-proxy-injects-host-side
fi
talyn_codex_proxy=${'${FLEET_PROXY_URL:-}'}
if [ -z "$talyn_codex_proxy" ] && [ -r /proc/cmdline ]; then
  talyn_codex_proxy=$(awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^fleet[.]proxy=/) { sub(/^fleet[.]proxy=/, "", $i); print $i; exit } }' /proc/cmdline)
fi
talyn_codex_proxy=${'${talyn_codex_proxy%/}'}
if [ -n "$talyn_codex_proxy" ]; then
  (
    umask 077
    mkdir -p "$HOME/.codex" || exit 1
    talyn_codex_config="$HOME/.codex/config.toml"
    talyn_codex_block=$(printf '%s\n' \
      '# BEGIN fleet codex provider — written by fleet-init; edits between the markers are lost' \
      'model_provider = "yas"' \
      'model_providers.yas.name = "OpenAI through the yas credential proxy"' \
      "model_providers.yas.base_url = \"$talyn_codex_proxy/v1\"" \
      'model_providers.yas.env_key = "OPENAI_API_KEY"' \
      'model_providers.yas.wire_api = "responses"' \
      '# END fleet codex provider')
    if [ -f "$talyn_codex_config" ] &&
      [ "$(sed -n '1,7p' "$talyn_codex_config")" = "$talyn_codex_block" ]; then
      exit 0
    fi
    talyn_codex_tmp="$talyn_codex_config.talyn.$$"
    trap 'rm -f "$talyn_codex_tmp"' 0
    {
      printf '%s\n' "$talyn_codex_block"
      if [ -f "$talyn_codex_config" ]; then
        awk -v begin='# BEGIN fleet codex provider — written by fleet-init; edits between the markers are lost' \
            -v end='# END fleet codex provider' '
          { lines[NR] = $0; if ($0 == begin) start = NR;
            if (start && $0 == end) { for (i = start; i <= NR; i++) skip[i] = 1; start = 0 } }
          END { for (i = 1; i <= NR; i++) if (!skip[i]) print lines[i] }
        ' "$talyn_codex_config"
      fi
    } > "$talyn_codex_tmp" || exit 1
    mv -f "$talyn_codex_tmp" "$talyn_codex_config" || exit 1
  ) || exit 1
fi`;
}
