/**
 * Boot ONE fleet sandbox the way Talyn does, on a workspace's real Claude
 * credential, and report what the run died of.
 *
 * The point is to separate "Anthropic refuses this account" (it does not —
 * every probe outside the sandbox answers 200) from "the sandbox path turns a
 * good request into a refused one". Everything here mirrors
 * `services/selfHosted/executor.ts`'s create body, so a difference in the
 * answer is a difference in the sandbox, not in how it was asked.
 *
 * Diagnostic only, run by hand:
 *
 *   npx tsx scripts/fleet-claude-repro.mts <workspaceId> [--keep]
 *
 * `--keep` boots a NON-ephemeral box, so it survives the failure and can be
 * ssh'd into.
 */
import { readFileSync } from 'fs';
import postgres from 'postgres';

const envFile = process.env.PROBE_ENV_FILE ?? '.env.prod';
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
}

const { decryptString } = await import('../src/services/tokenCrypto.ts');

const workspaceId = process.argv[2]!;
const keep = process.argv.includes('--keep');
const endpoint = process.env.FLEET_PINNED_ENDPOINT!;
const token = process.env.FLEET_GATEWAY_TOKEN!;
if (!endpoint || !token) throw new Error('FLEET_PINNED_ENDPOINT / FLEET_GATEWAY_TOKEN required');

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
const [row] = await sql`
  SELECT config FROM integrations
  WHERE workspace_id = ${workspaceId} AND type = 'selfhosted' LIMIT 1`;
const anthropicKey: string = decryptString((row!.config as any).claudeOAuth.accessTokenEnc);
await sql.end();

const api = async (path: string, init?: RequestInit): Promise<any> => {
  const res = await fetch(`${endpoint}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init?.headers as Record<string, string>),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

// The two things a REAL task carries that a toy one does not, each behind a
// flag so the difference can be bisected: the workspace's MCP servers (the
// loops inherit all of them) and open egress (`internetAccess`).
const withMcp = process.argv.includes('--mcp');
const openEgress = process.argv.includes('--open');
const repo = process.env.PROBE_REPO ?? 'Gilbert09/talyn';

let mcpServers: unknown[] = [];
if (withMcp) {
  const { mcpServersForDispatch } = await import('../src/services/mcpServers/store.ts');
  const only = (process.env.PROBE_MCP_ONLY ?? '').split(',').filter(Boolean);
  const all = await mcpServersForDispatch(workspaceId, null);
  const servers = only.length ? all.filter((sv: any) => only.includes(sv.name)) : all;
  mcpServers = servers.map((sv: any) => ({
    name: sv.name,
    url: sv.url,
    transport: 'http',
    ...(sv.description ? { description: sv.description } : {}),
    ...(sv.secret ? { secret: sv.secret } : {}),
    inject:
      sv.authKind === 'bearer'
        ? { kind: 'bearer', ...(sv.inject?.extra ? { extra: sv.inject.extra } : {}) }
        : sv.authKind === 'header'
          ? { kind: 'header', ...sv.inject }
          // `''`, not `'none'` — the fleet's own vocabulary for "no credential",
          // exactly as executor.ts's injectionFor sends it.
          : { kind: '' },
    ...(sv.tools === null ? {} : { tools: sv.tools }),
  }));
  console.log(`mcp servers: ${mcpServers.map((m: any) => m.name).join(', ') || '(none)'}`);
}

const id = `probe-claude-${Date.now().toString(36)}`;
console.log(`creating ${id} (ephemeral=${!keep}) at ${endpoint}`);

const created = await api('/v1/sandboxes', {
  method: 'POST',
  body: JSON.stringify({
    id,
    workspaceId,
    ephemeral: !keep,
    task: {
      taskType: 'code_writing',
      prompt: 'Reply with the single word: ok. Do not use any tools.',
      systemPrompt: 'You are a coding agent in a sandbox.',
      model: process.env.PROBE_MODEL ?? 'claude-sonnet-5',
      provider: 'anthropic',
      repo: { slug: repo, baseBranch: repo === 'Gilbert09/talyn' ? 'main' : 'master' },
    },
    anthropicKey,
    // Same suppression the executor sends: one vendor, never both.
    policy: {
      credentials: { openai: 'none' },
      ...(openEgress ? { egress: { mode: 'open' } } : {}),
    },
    ...(mcpServers.length ? { mcpServers } : {}),
  }),
});
console.log('created:', JSON.stringify({ id: created.id, status: created.status, host: created.host }));

// Poll the event stream until the run settles, printing anything that names a
// failure — the harness's own words are what this is for.
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const sandbox = await api(`/v1/sandboxes/${id}`).catch((e) => ({ status: `unreadable: ${e}` }));
  const events = await api(`/v1/sandboxes/${id}/events?after=0`).catch(() => null);
  const lines: string[] = (events?.events ?? events ?? [])
    .map((e: any) => JSON.stringify(e))
    .filter((l: string) => /fail|error|400|refus|usage|turn/i.test(l));
  if (lines.length) console.log(lines.slice(-3).join('\n').slice(0, 1200));
  console.log(`[${i}] status=${sandbox.status ?? '?'}`);
  if (['stopped', 'failed', 'completed', 'retired'].includes(String(sandbox.status))) break;
}

if (keep) console.log(`\nbox kept: ${id} — ssh in, then DELETE /v1/sandboxes/${id} when done`);
