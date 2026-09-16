import type { McpServerInput } from '@talyn/shared';

/**
 * The web fork's half of "already on this machine": nothing.
 *
 * Reading `~/.claude.json` and `~/.codex/config.toml` needs a filesystem, which
 * a browser does not have. The desktop version of this file does the scan over
 * IPC; here the section is simply absent, the way `HAS_LOCAL_SKILLS` makes the
 * skills group absent, rather than rendering one that is permanently empty.
 *
 * The props are kept identical so the two panels stay one file apart.
 */
export function LocalImport(_props: {
  connectedUrls: Set<string>;
  onImport: (input: McpServerInput) => void;
}) {
  return null;
}
