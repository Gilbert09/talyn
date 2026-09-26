/**
 * Drive pi-ai's real Anthropic request builder with the REAL posthog `exec`
 * tool, shaped exactly as the guest ships it (catalog.ts sanitise + rename +
 * description prefix). Bisect via PROBE_VARIANT.
 */
import { readFileSync, writeFileSync } from 'fs';
import postgres from 'postgres';

const BACKEND = '/Users/tomowers/dev/Gilbert09/fastowl/packages/backend';
const YAS = '/Users/tomowers/dev/Gilbert09/yas/runner';
const envFile = `${BACKEND}/.env.prod`;
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
}

const { decryptString } = await import(`${BACKEND}/src/services/tokenCrypto.ts`);
const { sanitiseSchema, describeTool, registeredName } = await import(`${YAS}/src/usermcp/catalog.ts`);
const PI = process.env.PI_DIST!;
const { stream } = await import(`${PI}/api/anthropic-messages.js`);

const workspaceId = process.argv[2]!;
const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
const [row] = await sql`
  SELECT config FROM integrations
  WHERE workspace_id = ${workspaceId} AND type = 'selfhosted' LIMIT 1`;
const token: string = decryptString((row!.config as any).claudeOAuth.accessTokenEnc);
await sql.end();

// --- fetch the real posthog exec decl over MCP ---
const { mcpServersForDispatch } = await import(`${BACKEND}/src/services/mcpServers/store.ts`);
const server = (await mcpServersForDispatch(workspaceId, null)).find((s: any) => s.name === 'posthog');
if (!server) throw new Error('no posthog server');
const secret = (server as any).secret ?? null;
const headers: Record<string, string> = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
if (secret) headers.authorization = `Bearer ${secret}`;
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
  return { json, sessionId: res.headers.get('mcp-session-id') ?? sessionId };
}
const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'talyn-probe', version: '0' },
});
const decls: any[] = (await rpc('tools/list', {}, init.sessionId)).json?.result?.tools ?? [];
const execDecl = decls.find((d) => d.name === 'exec');
if (!execDecl) throw new Error('no exec tool');
console.log(`exec: schema bytes raw=${JSON.stringify(execDecl.inputSchema).length}`);

const sanitised = sanitiseSchema(execDecl);
if (!sanitised.ok) throw new Error(`sanitise failed: ${(sanitised as any).reason}`);
console.log(`exec: schema bytes sanitised=${JSON.stringify(sanitised.schema).length}`);

const variant = process.env.PROBE_VARIANT ?? 'guest';
const execTool = (() => {
  switch (variant) {
    case 'guest': // exactly what mcp-tools.ts registers
      return {
        name: registeredName('posthog', 'exec'),
        description: describeTool('posthog', execDecl),
        parameters: sanitised.schema,
      };
    case 'raw-schema': // guest name/description, raw un-sanitised schema
      return {
        name: registeredName('posthog', 'exec'),
        description: describeTool('posthog', execDecl),
        parameters: execDecl.inputSchema,
      };
    case 'tiny-schema': // guest name/description, trivial schema
      return {
        name: registeredName('posthog', 'exec'),
        description: describeTool('posthog', execDecl),
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: [] },
      };
    case 'guest-ccname': // guest shape, Claude Code double-underscore name
      return {
        name: 'mcp__posthog__exec',
        description: describeTool('posthog', execDecl),
        parameters: sanitised.schema,
      };
    case 'full-desc': // guest shape but UNTRUNCATED description
      return {
        name: registeredName('posthog', 'exec'),
        description: `[MCP server "posthog"] ${execDecl.description ?? ''}`,
        parameters: sanitised.schema,
      };
    default:
      throw new Error(`unknown variant ${variant}`);
  }
})();

// The fleet's own tools as pi registers them (names only matter for shape).
const simple = (name: string) => ({
  name,
  description: `${name} does a thing`,
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
});
const fleetNames = ['read', 'write', 'bash', 'grep', 'get_check_logs', 'publish_commit', 'wait_for_checks'];
const TOOLS = process.env.PROBE_ONLY_EXEC ? [execTool] : [...fleetNames.map(simple), execTool];

const model = {
  id: process.env.PROBE_MODEL ?? 'claude-sonnet-5',
  name: 'claude-sonnet-5',
  api: 'anthropic-messages',
  provider: 'fleet',
  baseUrl: 'https://api.anthropic.com',
  reasoning: true,
  input: ['text'],
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

function asProxyWould(init: RequestInit | undefined): RequestInit | undefined {
  if (!init) return init;
  const h = new Headers(init.headers as HeadersInit);
  h.delete('authorization');
  h.delete('x-api-key');
  h.set('authorization', `Bearer ${token}`);
  const beta = h.get('anthropic-beta');
  h.set(
    'anthropic-beta',
    beta && !beta.includes('oauth-2025-04-20') ? `${beta},oauth-2025-04-20` : (beta ?? 'oauth-2025-04-20')
  );
  return { ...init, headers: h };
}

const dumpFile = process.env.PROBE_DUMP;
const loggingFetch: typeof fetch = async (input, initArg) => {
  const init = asProxyWould(initArg);
  const body = typeof init?.body === 'string' ? init.body : null;
  if (dumpFile && body) writeFileSync(dumpFile, body);
  if (dumpFile) {
    const hh: Record<string,string> = {};
    for (const [k,v] of new Headers(init?.headers as HeadersInit).entries()) hh[k] = /authorization|api-key/i.test(k) ? '<redacted>' : v;
    writeFileSync(dumpFile + '.headers.json', JSON.stringify(hh, null, 2));
  }
  const res = await fetch(input as RequestInfo, init);
  const clone = res.clone();
  console.log('status:', res.status);
  if (res.status !== 200) console.log('body:', (await clone.text()).slice(0, 400));
  return res;
};

console.log(`variant=${variant} tools=${TOOLS.length} onlyExec=${!!process.env.PROBE_ONLY_EXEC}`);
const events = stream(
  model,
  {
    systemPrompt: 'You are a coding agent working in a sandbox.',
    messages: [{ role: 'user', content: 'say hi' }],
    tools: TOOLS,
  },
  { apiKey: 'sk-ant-oat.not-a-key.the-fleet-proxy-injects-host-side', fetch: loggingFetch, maxRetries: 0 }
);
let sawText = false;
for await (const e of events as AsyncIterable<any>) {
  if (e.type === 'error') console.log('stream error:', JSON.stringify(e).slice(0, 500));
  if (e.type === 'done') { sawText = true; }
}
console.log('done, completed turn:', sawText);
