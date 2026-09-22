/**
 * Emit a curl config (stdin form) for ONE Claude Code-shaped request with a
 * workspace's stored Claude credential, so the same request can be run from
 * somewhere else — the fleet host — and compared.
 *
 * The config goes to STDOUT and is meant to be piped straight into
 * `curl --config -`, so the token never reaches argv or a file:
 *
 *   npx tsx scripts/emit-claude-curl-config.mts <workspaceId> | \
 *     ssh hetzner-64 'curl --config - -sS -o /dev/stdout -w "\n%{http_code}\n"'
 */
import { readFileSync } from 'fs';
import postgres from 'postgres';

const envFile = process.env.PROBE_ENV_FILE ?? '.env.prod';
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
}

const { decryptString } = await import('../src/services/tokenCrypto.ts');

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
const [row] = await sql`
  SELECT config FROM integrations
  WHERE workspace_id = ${process.argv[2]!} AND type = 'selfhosted' LIMIT 1`;
const token: string = decryptString((row!.config as any).claudeOAuth.accessTokenEnc);
await sql.end();

const body = JSON.stringify({
  model: process.env.PROBE_MODEL ?? 'claude-sonnet-5',
  max_tokens: 1,
  system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
  messages: [{ role: 'user', content: 'hi' }],
});

// curl's config format: one directive per line, values quoted, backslash-escaped.
const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
process.stdout.write(
  [
    `url = ${q('https://api.anthropic.com/v1/messages')}`,
    `header = ${q(`authorization: Bearer ${token}`)}`,
    `header = ${q('anthropic-version: 2023-06-01')}`,
    `header = ${q('anthropic-beta: claude-code-20250219,oauth-2025-04-20')}`,
    `header = ${q('content-type: application/json')}`,
    `header = ${q('x-app: cli')}`,
    `user-agent = ${q('claude-cli/2.0.0 (external, cli)')}`,
    `data = ${q(body)}`,
    '',
  ].join('\n')
);
