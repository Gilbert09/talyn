import fs from 'fs/promises';
import os from 'os';
import path from 'path';

/**
 * MCP MCP servers already configured on this machine.
 *
 * Somebody who has wired up Supabase or Context7 for their own Claude should
 * not have to go and find the URL again, so this reads what is already there
 * and offers it.
 *
 * # What can and cannot come along
 *
 * The fleet carries REMOTE streamable-HTTP servers only. An stdio server has
 * nowhere in the sandbox to keep its credentials that the sandbox could not
 * read, and a `http://127.0.0.1:...` one is not reachable from a microVM at
 * all. Both are still REPORTED, with the reason: dropping them silently would
 * leave somebody hunting for a server they can see in their own config and
 * concluding the scan is broken.
 *
 * # Why no credential is read
 *
 * A `headers` value in one of these files is a live secret — there are two on
 * the machine this was written on. Copying one into an IPC payload so the
 * renderer can POST it back would put it through two more places than it needs
 * to be, and would mean a bug in either one leaks it. The importer offers the
 * ADDRESS; the key is typed once, into the field that encrypts it. What is
 * reported is whether a credential is there, so the UI can say "you will need
 * to paste the key again".
 *
 * # Why it lives in main
 *
 * The renderer has no filesystem. `apps/web` has no equivalent and hides the
 * affordance — see `HAS_LOCAL_MCP` in its env module.
 */

/** `~/.claude.json` also carries session state and per-project history, so it
 *  is routinely megabytes. Read anyway up to a bound; past it, skipped. */
const MAX_BYTES = 8 * 1024 * 1024;

export interface LocalMcpFinding {
  name: string;
  /** Where it was found, for a human: "Claude Code", "Codex", a project name. */
  source: string;
  url: string | null;
  transport: string;
  importable: boolean;
  /** Why it cannot be imported, in words. Absent when it can. */
  reason?: string;
  /** Whether the local config holds a credential this deliberately did not read. */
  hasLocalCredential: boolean;
}

/** Hosts a sandbox has no route to. Mirrors the shared validator's rule. */
function isUnreachableHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h === '::1' ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^0\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

/** Decide whether one entry could reach a sandbox, and say why when it cannot. */
function judge(
  name: string,
  source: string,
  url: string | null,
  transport: string,
  hasLocalCredential: boolean
): LocalMcpFinding {
  const base = { name, source, url, transport, hasLocalCredential };
  if (!url) {
    return {
      ...base,
      importable: false,
      reason:
        'it runs a command on this machine. A sandbox has nowhere to keep that command’s ' +
        'credentials that the sandbox itself could not read, so only remote servers can come along.',
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ...base, importable: false, reason: 'its address is not a URL.' };
  }
  if (isUnreachableHost(parsed.hostname)) {
    return {
      ...base,
      importable: false,
      reason:
        `a sandbox has no route to ${parsed.hostname} — it reaches the servers it is given ` +
        'and nothing on your machine or your network.',
    };
  }
  if (transport === 'sse') {
    return {
      ...base,
      importable: false,
      reason:
        'it speaks the older SSE transport, which the fleet does not carry. Most vendors now ' +
        'serve the same server over streamable HTTP.',
    };
  }
  return { ...base, importable: true };
}

/**
 * Read every place an MCP server can be configured on this machine.
 *
 * Re-read on every call — no cache and no watcher, matching `skills:list-local`.
 * A missing file is not an error: most machines have none of these.
 */
export async function scanLocalMcpServers(homeDir?: string): Promise<LocalMcpFinding[]> {
  // The parameter exists for the test, which points it at a fixture tree. The
  // main process always calls it with nothing.
  const home = homeDir ?? os.homedir();
  const out: LocalMcpFinding[] = [];
  // Deduplicated by name AND address: the same server is commonly configured in
  // several projects, and one row per project would be noise rather than
  // information.
  const seen = new Set<string>();

  const addJson = (servers: unknown, source: string): void => {
    if (typeof servers !== 'object' || servers === null) return;
    for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
      if (typeof raw !== 'object' || raw === null) continue;
      const e = raw as Record<string, unknown>;
      const url = typeof e.url === 'string' ? e.url : null;
      const transport = typeof e.type === 'string' ? e.type : url ? 'http' : 'stdio';
      const headers = e.headers as Record<string, unknown> | undefined;
      const env = e.env as Record<string, unknown> | undefined;
      const hasCred =
        (typeof headers === 'object' && headers !== null && Object.keys(headers).length > 0) ||
        (typeof env === 'object' && env !== null && Object.keys(env).length > 0);
      const key = `${name} ${url ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(judge(name, source, url, transport, hasCred));
    }
  };

  // ~/.claude.json: user scope at the top level, and a per-project map.
  //
  // BOTH matter, and the second is the one that pays: in practice almost every
  // remote server somebody has is project-scoped, so reading only the top level
  // finds the stdio ones and none of the servers that could actually be used.
  try {
    const file = path.join(home, '.claude.json');
    const stat = await fs.stat(file);
    if (stat.size <= MAX_BYTES) {
      const doc = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      addJson(doc.mcpServers, 'Claude Code');
      const projects = doc.projects as Record<string, { mcpServers?: unknown }> | undefined;
      for (const [dir, project] of Object.entries(projects ?? {})) {
        addJson(project?.mcpServers, `Claude Code · ${path.basename(dir)}`);
      }
    }
  } catch {
    // Absent or unreadable. Ordinary, and not worth a message.
  }

  // Claude Desktop's own config. stdio only in practice, but reported for the
  // same reason the stdio entries above are.
  try {
    const file = path.join(
      home,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    );
    const doc = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    addJson(doc.mcpServers, 'Claude Desktop');
  } catch {
    // Absent on Windows and Linux, and on any Mac without the app.
  }

  out.push(...(await scanCodexConfig(home, seen)));
  return out;
}

/**
 * `~/.codex/config.toml`, hand-parsed.
 *
 * One shape is wanted — `[mcp_servers.<name>]` tables with a `url` or a
 * `command` — and pulling a TOML parser into the main process to read it would
 * be a dependency for six lines. The parse is deliberately shallow: anything it
 * does not understand yields an entry with no url, which is reported as "runs a
 * command", and the worst that costs is one row somebody has to add by hand.
 */
async function scanCodexConfig(home: string, seen: Set<string>): Promise<LocalMcpFinding[]> {
  const out: LocalMcpFinding[] = [];
  let text: string;
  try {
    text = await fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf8');
  } catch {
    return out;
  }

  let name: string | null = null;
  let url: string | null = null;
  let hasCred = false;

  const flush = (): void => {
    if (!name) return;
    const key = `${name} ${url ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(judge(name, 'Codex', url, url ? 'http' : 'stdio', hasCred));
    }
    name = null;
    url = null;
    hasCred = false;
  };

  for (const line of text.split(/\r?\n/)) {
    const table = /^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/.exec(line);
    if (table) {
      flush();
      name = table[1] ?? table[2] ?? null;
      continue;
    }
    // Any other table header ends this server's block.
    if (/^\s*\[/.test(line)) {
      flush();
      continue;
    }
    if (!name) continue;
    const found = /^\s*url\s*=\s*"([^"]*)"/.exec(line);
    if (found) url = found[1] ?? null;
    // Codex references a token by ENV VAR NAME rather than inline, so this is
    // "there is a credential arrangement here", not a credential.
    if (/^\s*(env|http_headers|env_http_headers|bearer_token_env_var)\s*=/.test(line)) {
      hasCred = true;
    }
  }
  flush();
  return out;
}
