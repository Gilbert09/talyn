/**
 * One live call to Anthropic with a workspace's STORED Claude credential, to
 * answer "is the vendor actually refusing us right now, and in what words".
 *
 * Diagnostic only — run by hand with the prod env, never imported by the app.
 * Prints statuses, headers and bodies; never a token.
 *
 *   npx tsx scripts/probe-claude-credential.ts <workspaceId>
 */
import { readFileSync } from 'fs';
import postgres from 'postgres';
const { CLAUDE_CLIENT_ID, CLAUDE_TOKEN_URL } = await import(
  '../src/services/selfHosted/claudeOauth.ts'
);
const { decryptString } = await import('../src/services/tokenCrypto.ts');

// Load .env.prod explicitly rather than through dotenv's cwd search, so this
// can never pick up the local dev database by accident.
const envFile = process.env.PROBE_ENV_FILE ?? '.env.prod';
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
}

const workspaceId = process.argv[2];
if (!workspaceId) throw new Error('usage: probe-claude-credential.ts <workspaceId>');

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
const [row] = await sql`
  SELECT config FROM integrations
  WHERE workspace_id = ${workspaceId} AND type = 'selfhosted' LIMIT 1`;
if (!row) throw new Error('no selfhosted integration for that workspace');

const cfg = row.config as Record<string, any>;
const cred = cfg.claudeOAuth;
if (!cred) throw new Error('no claudeOAuth credential stored');

console.log('--- what Talyn has stored ---');
console.log('expiresAt             :', cred.expiresAt);
console.log('reauthRequiredAt      :', cred.reauthRequiredAt ?? '(none)');
console.log('quotaExhausted.claude :', JSON.stringify(cfg.quotaExhausted?.claude ?? null));

let access: string = decryptString(cred.accessTokenEnc);
const refresh: string = decryptString(cred.refreshTokenEnc);
console.log('access token          :', `${access.slice(0, 11)}…(${access.length} chars)`);
console.log('access token expired? :', Date.parse(cred.expiresAt) < Date.now());

// Refresh when the stored access token is at or past its expiry — otherwise a
// 401 would be about the clock rather than about usage. NOT persisted: this
// script never writes.
if (Date.parse(cred.expiresAt) - Date.now() < 60_000) {
  const res = await fetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: CLAUDE_CLIENT_ID,
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  console.log('\n--- refresh ---');
  console.log('status                :', res.status);
  console.log('granted scope         :', body.scope ?? '(absent)');
  console.log('error                 :', body.error ?? '(none)');
  if (res.ok && body.access_token) access = body.access_token as string;
  else throw new Error('refresh failed — cannot probe');
}

async function probe(model: string): Promise<void> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${access}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'content-type': 'application/json',
      'user-agent': 'claude-cli/2.0.0 (external, cli)',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      // The OAuth/subscription path requires Claude Code's own first system
      // block; without it Anthropic refuses for a reason that has nothing to
      // do with usage.
      system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  const text = await res.text();
  console.log(`\n--- POST /v1/messages  model=${model} ---`);
  console.log('status                :', res.status);
  for (const h of [
    'anthropic-ratelimit-unified-status',
    'anthropic-ratelimit-unified-reset',
    'anthropic-ratelimit-unified-remaining',
    'retry-after',
  ]) {
    const v = res.headers.get(h);
    if (v) console.log(`${h.padEnd(22)}:`, v);
  }
  console.log('body                  :', text.slice(0, 500));
}

for (const model of (process.env.PROBE_MODELS ?? 'claude-sonnet-5,claude-opus-5').split(',')) {
  await probe(model.trim());
}

await sql.end();
