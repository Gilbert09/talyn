/**
 * Reproduce the request the FLEET'S HARNESS builds, outside the fleet.
 *
 * The fleet's Claude runs die on Anthropic's "You're out of extra usage" while
 * the same credential answers 200 to a hand-built Claude Code request — from
 * this machine AND from the fleet host. So the difference is in the body the
 * harness builds, and this runs that exact code (`@earendil-works/pi-ai`, the
 * version the guest image pins) with a logging fetch.
 *
 *   npx tsx scripts/repro-pi-anthropic.mts <workspaceId>
 */
import { readFileSync } from 'fs';
import postgres from 'postgres';

const envFile = process.env.PROBE_ENV_FILE ?? '.env.prod';
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
}

const { decryptString } = await import('../src/services/tokenCrypto.ts');
const PI = process.env.PI_DIST!;
const { stream } = await import(`${PI}/api/anthropic-messages.js`);

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
const [row] = await sql`
  SELECT config FROM integrations
  WHERE workspace_id = ${process.argv[2]!} AND type = 'selfhosted' LIMIT 1`;
const token: string = decryptString((row!.config as any).claudeOAuth.accessTokenEnc);
await sql.end();

// Mirrors runner/src/pi/provider.ts's entry for claude-sonnet-5.
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

/**
 * Stand in for the fleet's credential proxy: strip whatever the guest sent
 * (isForbiddenInbound drops Authorization and X-Api-Key), then attach the real
 * token exactly as authAnthropic does — Bearer + an APPENDED oauth beta.
 */
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

const loggingFetch: typeof fetch = async (input, init) => {
  init = asProxyWould(init);
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  console.log('--- request ---');
  console.log('headers:', JSON.stringify(sanitize(init?.headers), null, 2));
  console.log('body keys:', Object.keys(body ?? {}).join(', '));
  console.log('body (trimmed):', JSON.stringify(trim(body), null, 2).slice(0, 1800));
  const res = await fetch(input as RequestInfo, init);
  const clone = res.clone();
  console.log('--- response ---');
  console.log('status:', res.status);
  console.log('body:', (await clone.text()).slice(0, 400));
  return res;
};

/** Headers minus the credential. */
function sanitize(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const entries =
    h instanceof Headers ? [...h.entries()] : Object.entries((h ?? {}) as Record<string, string>);
  for (const [k, v] of entries) {
    out[k] = /^(authorization|x-api-key)$/i.test(k) ? `<${v.slice(0, 14)}…>` : String(v);
  }
  return out;
}

/** The body with long message/tool arrays summarised. */
function trim(b: any): unknown {
  if (!b) return b;
  return {
    ...b,
    messages: `[${b.messages?.length ?? 0} messages]`,
    ...(b.tools ? { tools: `[${b.tools.length} tools: ${b.tools.slice(0, 6).map((t: any) => t.name).join(', ')}…]` } : {}),
  };
}

/**
 * `PROBE_TOOL_KB` pads a tool's DESCRIPTION. An MCP server's tools arrive with
 * whatever prose the vendor wrote, and PostHog's `exec` carries a manual —
 * which is the one difference between a fleet run that completes and one
 * Anthropic refuses.
 */
const tool = (name: string) => ({
  name,
  description: process.env.PROBE_TOOL_KB
    ? `${name} does a thing. ${'Describe the thing at length. '.repeat(
        (Number(process.env.PROBE_TOOL_KB) * 1024) / 30
      )}`
    : `${name} does a thing`,
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
});
/** A few of Claude Code's own, then the fleet's, which are nobody else's. */
const TOOLS =
  process.env.PROBE_TOOLS === 'cconly'
    ? ['read', 'write', 'bash', 'grep'].map(tool)
    : ['read', 'write', 'bash', 'grep', 'get_check_logs', 'git_signed_merge', 'fleet_publish'].map(
        tool
      );

const PLACEHOLDER_KEY = 'not-a-key-the-fleet-proxy-injects-host-side';
const PLACEHOLDER_KEY_OAUTH = 'sk-ant-oat.not-a-key.the-fleet-proxy-injects-host-side';
const guestKey = process.env.PROBE_GUEST_KEY === 'plain' ? PLACEHOLDER_KEY : PLACEHOLDER_KEY_OAUTH;
console.log(`guest holds: ${guestKey}\n`);

const events = stream(
  model,
  {
    systemPrompt: 'You are a coding agent working in a sandbox.',
    // A real turn is not two words. `PROBE_PAD_KB` pads the user message so the
    // request's SIZE can be varied — the one dimension a toy probe cannot
    // reach, and the one Anthropic's cost estimate keys on alongside
    // max_tokens (128k here, straight from Pi's model table).
    messages: [
      {
        role: 'user',
        content: process.env.PROBE_PAD_KB
          ? `say hi\n\n${'lorem ipsum dolor sit amet. '.repeat(
              (Number(process.env.PROBE_PAD_KB) * 1024) / 28
            )}`
          : 'say hi',
      },
    ],
    // The guest's real turn carries tools. Pi renames the ones Claude Code
    // also has (`toClaudeCodeName`) and leaves the fleet's own alone, so a
    // Claude-Code-identity request goes out carrying tool names Claude Code
    // does not have — which is the next candidate difference.
    tools: process.env.PROBE_TOOLS === 'none' ? [] : TOOLS,
  },
  // What the GUEST holds, which is never the real token: the fleet hands it a
  // placeholder and the proxy swaps in the credential host-side. Which
  // placeholder it gets is the whole question — Pi enters its Claude Code
  // "OAuth stealth" mode only when the string contains `sk-ant-oat`.
  { apiKey: guestKey, fetch: loggingFetch, maxRetries: 0 }
);

for await (const e of events as AsyncIterable<any>) {
  if (e.type === 'error') console.log('stream error:', JSON.stringify(e).slice(0, 400));
}
