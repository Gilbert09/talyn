/** Replay the captured failing body with mutations, using the real token. */
import { readFileSync } from 'fs';
import postgres from 'postgres';
const BACKEND = '/Users/tomowers/dev/Gilbert09/fastowl/packages/backend';
for (const line of readFileSync(`${BACKEND}/.env.prod`, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
}
const { decryptString } = await import(`${BACKEND}/src/services/tokenCrypto.ts`);

const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
const [row] = await sql`
  SELECT config FROM integrations
  WHERE workspace_id = ${'5f6bb4d9-2c38-4825-a304-683e08a6ae20'} AND type = 'selfhosted' LIMIT 1`;
const token: string = decryptString((row!.config as any).claudeOAuth.accessTokenEnc);
await sql.end();

const body = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
// mutation named by MUT env var
const mut = process.env.MUT ?? 'none';
const tools: any[] = body.tools ?? [];
const execTool = tools.find((t) => t.name.includes('exec'));
switch (mut) {
  case 'none': break;
  case 'drop-exec': body.tools = tools.filter((t) => t !== execTool); break;
  case 'exec-desc-plain': execTool.description = 'runs a posthog command'; break;
  case 'exec-name-foo': execTool.name = 'my_exec_tool'; break;
  case 'name-cc': execTool.name = 'mcp__posthog__exec'; break;
  case 'name-ctx7': execTool.name = 'mcp_context7_exec'; break;
  case 'name-ph-query': execTool.name = 'mcp_posthog_query'; break;
  case 'name-ph-exec2': execTool.name = 'mcp_posthog_exec2'; break;
  case 'name-noprefix': execTool.name = 'posthog_exec'; break;
  case 'name-mcp-exec': execTool.name = 'mcp_exec'; break;
  case 'name-ctx7-real': execTool.name = 'mcp_context7_resolve-library-id'; break;
  case 'name-ph-hyphen': execTool.name = 'mcp_posthog_exec-cmd'; break;
  case 'name-case': execTool.name = 'Mcp_posthog_exec'; break;
  case 'name-mcp-only': execTool.name = 'mcp_'; break;
  case 'name-underscore-tail': execTool.name = 'mcp_posthog_'; break;
  case 'exec-no-eager': delete execTool.eager_input_streaming; break;
  case 'all-no-eager': for (const t of tools) delete t.eager_input_streaming; break;
  case 'exec-no-cache': delete execTool.cache_control; break;
  case 'desc-no-prefix': execTool.description = execTool.description.replace('[MCP server "posthog"] ', ''); break;
  case 'desc-half1': execTool.description = execTool.description.slice(0, 510); break;
  case 'desc-half2': execTool.description = '[MCP server "posthog"] ' + execTool.description.slice(510); break;
  default: throw new Error(`unknown MUT ${mut}`);
}
const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': process.env.BETAS ?? 'oauth-2025-04-20',
    'anthropic-dangerous-direct-browser-access': 'true',
    'user-agent': process.env.UA ?? 'pi-ai/0.84.1',
  },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log(`MUT=${mut} status=${res.status} ${text.slice(0, 160).replace(/\n/g, ' ')}`);
