import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { scanLocalMcpServers } from '../main/localMcp';

/**
 * What the local scan offers, and what it refuses.
 *
 * The refusals matter as much as the imports. The fleet carries remote
 * streamable-HTTP servers only, so an stdio server and a loopback one cannot
 * come along — and both have to be REPORTED with a reason, because a server
 * somebody can see in their own config and not in this list reads as a broken
 * scan rather than a product boundary.
 */

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'talyn-mcp-'));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

async function writeClaudeJson(doc: unknown) {
  await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify(doc));
}

describe('scanLocalMcpServers', () => {
  it('finds nothing, quietly, on a machine with no config', async () => {
    expect(await scanLocalMcpServers(home)).toEqual([]);
  });

  // The one that pays. Almost every remote server somebody has is project
  // scoped, so a scan that read only the top level would find the stdio ones
  // and none of the servers that could actually be used.
  it('reads per-project servers, not just the user scope', async () => {
    await writeClaudeJson({
      mcpServers: { top: { type: 'http', url: 'https://mcp.example.com/mcp' } },
      projects: {
        '/Users/someone/dev/club_app': {
          mcpServers: { supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' } },
        },
      },
    });
    const found = await scanLocalMcpServers(home);
    expect(found.map((f) => f.name).sort()).toEqual(['supabase', 'top']);
    expect(found.every((f) => f.importable)).toBe(true);
    expect(found.find((f) => f.name === 'supabase')?.source).toContain('club_app');
  });

  it.each([
    ['an stdio server', { chrome: { command: 'npx', args: ['x'] } }, /runs a command on this machine/],
    [
      'a loopback server',
      { local: { type: 'http', url: 'http://127.0.0.1:4517/mcp' } },
      /no route to 127\.0\.0\.1/,
    ],
    [
      'a private-network server',
      { lan: { type: 'http', url: 'http://192.168.1.9/mcp' } },
      /no route to 192\.168\.1\.9/,
    ],
    [
      'an SSE server',
      { old: { type: 'sse', url: 'https://mcp.example.com/sse' } },
      /older SSE transport/,
    ],
  ])('reports %s rather than dropping it', async (_label, servers, reason) => {
    await writeClaudeJson({ mcpServers: servers });
    const [found] = await scanLocalMcpServers(home);
    expect(found?.importable).toBe(false);
    expect(found?.reason).toMatch(reason);
  });

  // A server configured in six projects is one server, not six rows.
  it('deduplicates the same server across projects', async () => {
    const entry = { strava: { type: 'http', url: 'https://mcp.strava.com/mcp' } };
    await writeClaudeJson({
      projects: { '/a': { mcpServers: entry }, '/b': { mcpServers: entry } },
    });
    expect(await scanLocalMcpServers(home)).toHaveLength(1);
  });

  // No credential is read, ever. What is reported is that one EXISTS, so the
  // UI can say "you will need to paste the key again".
  it('reports that a credential exists without carrying it', async () => {
    await writeClaudeJson({
      mcpServers: {
        ctx: {
          type: 'http',
          url: 'https://mcp.context7.com/mcp',
          headers: { CONTEXT7_API_KEY: 'ctx7sk-super-secret' },
        },
      },
    });
    const [found] = await scanLocalMcpServers(home);
    expect(found?.hasLocalCredential).toBe(true);
    expect(JSON.stringify(found)).not.toContain('super-secret');
  });

  describe('codex config.toml', () => {
    it('reads url tables and treats a command table as stdio', async () => {
      await fs.mkdir(path.join(home, '.codex'), { recursive: true });
      await fs.writeFile(
        path.join(home, '.codex', 'config.toml'),
        [
          'preferred_auth_method = "apikey"',
          '',
          '[mcp_servers.figma]',
          'url = "https://mcp.figma.com/mcp"',
          '',
          '[mcp_servers."context7"]',
          'command = "npx"',
          '',
          '[projects."/some/path"]',
          'trust_level = "trusted"',
        ].join('\n')
      );
      const found = await scanLocalMcpServers(home);
      expect(found.map((f) => [f.name, f.importable])).toEqual([
        ['figma', true],
        ['context7', false],
      ]);
      // The trailing [projects.…] table must not be read as a server.
      expect(found.some((f) => f.name.includes('/some/path'))).toBe(false);
    });
  });
});
