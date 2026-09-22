/**
 * Fetch a workspace MCP server's tool list, then ask Anthropic to accept it.
 *
 * A fleet run with the PostHog MCP server attached is refused with "You're out
 * of extra usage"; the identical run without it completes. Neither request size
 * nor tool-description size reproduces that outside the sandbox, so the next
 * question is what those particular tool DEFINITIONS do — which needs the real
 * ones.
 *
 *   npx tsx scripts/probe-mcp-tools.mts <workspaceId> <serverName>
 */
import { readFileSync } from 'fs';
import postgres from 'postgres';

const envFile = process.env.PROBE_ENV_FILE ?? '.env.prod';
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
}

const { decryptString } = await import('../src/services/tokenCrypto.ts');
const [workspaceId, serverName] = [process.argv[2]!, process.argv[3] ?? 'posthog'];

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
const [integration] = await sql`
  SELECT config FROM integrations
  WHERE workspace_id = ${workspaceId} AND type = 'selfhosted' LIMIT 1`;
const anthropicToken: string = decryptString((integration!.config as any).claudeOAuth.accessTokenEnc);
await sql.end();

// Through the dispatch path, not raw SQL: it is the one function that decrypts
// a server's credential, and an OAuth-connected server keeps it somewhere a
// hand-written SELECT would miss.
const { mcpServersForDispatch } = await import('../src/services/mcpServers/store.ts');
const server = (await mcpServersForDispatch(workspaceId, null)).find(
  (s: any) => s.name === serverName
);
if (!server) throw new Error(`no MCP server named ${serverName}`);
const secret = (server as any).secret ?? null;
const headers: Record<string, string> = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
if (secret) headers.authorization = `Bearer ${secret}`;

/** One JSON-RPC call over streamable HTTP. */
async function rpc(method: string, params: unknown, sessionId?: string): Promise<any> {
  const res = await fetch(String(server.url), {
    method: 'POST',
    headers: { ...headers, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  const json = text.startsWith('event:')
    ? JSON.parse(text.split('\n').find((l) => l.startsWith('data:'))!.slice(5))
    : JSON.parse(text || '{}');
  return { json, sessionId: res.headers.get('mcp-session-id') ?? sessionId, status: res.status };
}

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'talyn-probe', version: '0' },
});
const listed = await rpc('tools/list', {}, init.sessionId);
const tools: any[] = listed.json?.result?.tools ?? [];
console.log(`${serverName}: ${tools.length} tools`);
for (const t of tools) {
  console.log(
    `  ${t.name} — name ${t.name.length} chars, description ${(t.description ?? '').length} chars`
  );
}

// Now ask Anthropic to accept them, in the shape the harness sends: Claude
// Code's identity, the two betas, MCP names as `mcp__<server>__<tool>`.
async function ask(subset: any[], label: string): Promise<void> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${anthropicToken}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      'content-type': 'application/json',
      'user-agent': 'claude-cli/2.1.75',
      'x-app': 'cli',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1,
      system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      messages: [{ role: 'user', content: 'hi' }],
      tools: subset.map((t) => ({
        name: `mcp__${serverName}__${t.name}`,
        description: t.description ?? '',
        input_schema: t.inputSchema ?? { type: 'object', properties: {} },
      })),
    }),
  });
  const body = await res.text();
  console.log(`\n[${res.status}] ${label}`);
  console.log(`  ${body.slice(0, 300)}`);
}

await ask(tools, `all ${tools.length} tools`);
for (const t of tools) await ask([t], `just ${t.name}`);
