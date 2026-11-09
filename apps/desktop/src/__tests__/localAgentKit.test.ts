import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  CODEX_MARKER,
  LOCAL_SKILL_STAMP,
  addCodexServer,
  installLocalAgentKit,
  readCodexServer,
  readLocalAgentKit,
  refreshLocalSkills,
  removeCodexServer,
  removeLocalAgentKit,
} from '../main/localAgentKit';
import { LOCAL_SKILL_PACK } from '../main/localSkillPack';

const ENDPOINT = 'https://prod.talyn.dev/api/v1/mcp';
const TOKEN = 'talyn_mcp_abcdef0123456789ABCDEFghijkl-_xyz';
const TOKEN_2 = 'talyn_mcp_zzzzzz0123456789ABCDEFghijkl-_xyz';
const SANDBOX_PACK = ['talyn-multi-repo', 'talyn-delegate', 'talyn-ci-triage', 'talyn-ship-pr',
  'talyn-review-loop', 'talyn-wrap-up', 'talyn-memory', 'talyn-thread', 'talyn-speed'];

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'talyn-agents-'));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const claudeJson = () => path.join(home, '.claude.json');
const codexToml = () => path.join(home, '.codex', 'config.toml');
const readJson = async () => JSON.parse(await fs.readFile(claudeJson(), 'utf8'));
const install = (agents: ('claude' | 'codex')[] = ['claude', 'codex'], token = TOKEN) =>
  installLocalAgentKit({ endpoint: ENDPOINT, token, agents }, home);

describe('local skill pack', () => {
  it.each(LOCAL_SKILL_PACK.map((s) => [s.name, s] as const))('%s has valid frontmatter', (name, skill) => {
    const m = /^---\nname: (.+)\ndescription: (.+)\n---\n\n/.exec(skill.content);
    expect(m?.[1]).toBe(name);
    expect(m?.[2]).toBe(skill.description);
    expect(name).toMatch(/^talyn-[a-z-]+$/);
    // Codex refuses a longer description; Claude Code's limit is the same.
    expect(skill.description.length).toBeLessThanOrEqual(1024);
    expect(skill.description).not.toMatch(/\n/);
  });

  it('never reuses a sandbox skill name', () => {
    for (const { name } of LOCAL_SKILL_PACK) expect(SANDBOX_PACK).not.toContain(name);
  });

  it('has unique names', () => {
    const names = LOCAL_SKILL_PACK.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('Codex config edits', () => {
  it.each([
    ['an empty file', ''],
    ['other settings', 'model = "gpt-5"\n\n[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n'],
    ['an old talyn table', '[mcp_servers.talyn]\nurl = "http://localhost:4747/api/v1/mcp"\n'],
    ['a quoted talyn table', '[mcp_servers."talyn"]\nurl = "x"\n'],
    ['a talyn sub-table', '[mcp_servers.talyn]\nurl = "x"\n[mcp_servers.talyn.tools.foo]\nenabled = true\n'],
    ['an inline talyn key', '[mcp_servers]\ntalyn = { url = "x" }\n'],
    ['a dotted talyn key', 'mcp_servers.talyn.url = "x"\n'],
    ['our earlier block', `model = "o3"\n\n${CODEX_MARKER}\n[mcp_servers.talyn]\nurl = "x"\nhttp_headers = { Authorization = "Bearer old" }\n`],
  ])('leaves exactly one talyn server after %s', (_label, before) => {
    const after = addCodexServer(before, ENDPOINT, TOKEN);
    expect(after.match(/^\[mcp_servers\.talyn\]$/gm)).toHaveLength(1);
    expect(after).not.toMatch(/mcp_servers\."talyn"|^talyn\s*=|mcp_servers\.talyn\.url|tools\.foo/m);
    expect(after.split(CODEX_MARKER)).toHaveLength(2);
    expect(readCodexServer(after)).toEqual({ url: ENDPOINT, tokenPrefix: TOKEN.slice(0, 16) });
  });

  it('keeps every other line byte for byte', () => {
    const before = [
      '# my settings',
      'model = "gpt-5"',
      '',
      '[mcp_servers.linear]',
      'url = "https://mcp.linear.app/mcp"',
      '',
      '[mcp_servers.talyn]',
      'url = "x"',
      '',
      '[profiles.fast]',
      'model = "gpt-5-mini"',
      '',
    ].join('\n');
    const after = removeCodexServer(before);
    expect(after).toBe(
      ['# my settings', 'model = "gpt-5"', '', '[mcp_servers.linear]', 'url = "https://mcp.linear.app/mcp"', '',
        '[profiles.fast]', 'model = "gpt-5-mini"', ''].join('\n')
    );
  });

  it('keeps CRLF line endings', () => {
    const after = addCodexServer('model = "gpt-5"\r\n', ENDPOINT, TOKEN);
    expect(after).toContain('\r\n[mcp_servers.talyn]\r\n');
    expect(after.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('is unchanged by a second add with the same values', () => {
    const once = addCodexServer('model = "gpt-5"\n', ENDPOINT, TOKEN);
    expect(addCodexServer(once, ENDPOINT, TOKEN)).toBe(once);
  });

  it('removes to an empty file when talyn was the only thing in it', () => {
    expect(removeCodexServer(addCodexServer('', ENDPOINT, TOKEN))).toBe('');
  });
});

describe('installLocalAgentKit', () => {
  it('connects both agents on a machine with no config', async () => {
    const status = await install();
    expect(status.errors).toEqual([]);
    for (const agent of status.agents) {
      expect(agent.mcpUrl).toBe(ENDPOINT);
      expect(agent.tokenPrefix).toBe(TOKEN.slice(0, 16));
      expect(agent.skills).toEqual(LOCAL_SKILL_PACK.map((s) => s.name));
      expect(agent.blockedSkills).toEqual([]);
    }
    expect((await readJson()).mcpServers.talyn).toEqual({
      type: 'http',
      url: ENDPOINT,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    for (const root of ['.claude', '.codex']) {
      for (const skill of LOCAL_SKILL_PACK) {
        const dir = path.join(home, root, 'skills', skill.name);
        expect(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')).toBe(skill.content);
        await expect(fs.stat(path.join(dir, LOCAL_SKILL_STAMP))).resolves.toBeTruthy();
      }
    }
  });

  it('keeps the rest of ~/.claude.json, including project servers', async () => {
    await fs.writeFile(
      claudeJson(),
      JSON.stringify({
        numStartups: 12,
        mcpServers: { context7: { type: 'http', url: 'https://mcp.context7.com/mcp' } },
        projects: { '/x': { mcpServers: { talyn: { type: 'http', url: 'http://localhost' } } } },
      })
    );
    await install(['claude']);
    const doc = await readJson();
    expect(doc.numStartups).toBe(12);
    expect(Object.keys(doc.mcpServers).sort()).toEqual(['context7', 'talyn']);
    expect(doc.projects['/x'].mcpServers.talyn.url).toBe('http://localhost');
  });

  it('writes the token files without group or other access', async () => {
    if (process.platform === 'win32') return;
    await fs.writeFile(claudeJson(), '{}', { mode: 0o644 });
    await install();
    expect((await fs.stat(claudeJson())).mode & 0o077).toBe(0);
    expect((await fs.stat(codexToml())).mode & 0o077).toBe(0);
  });

  it('writes through a symlinked config, so a dotfiles link stays a link', async () => {
    // A symlink on Windows needs developer mode or admin rights.
    if (process.platform === 'win32') return;
    const real = path.join(home, 'dotfiles', 'config.toml');
    await fs.mkdir(path.dirname(real), { recursive: true });
    await fs.writeFile(real, 'model = "gpt-5"\n');
    await fs.mkdir(path.join(home, '.codex'));
    await fs.symlink(real, codexToml());
    await install(['codex']);
    expect((await fs.lstat(codexToml())).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(real, 'utf8')).toContain('[mcp_servers.talyn]');
  });

  it('refuses to replace ~/.claude.json that does not parse, and still connects Codex', async () => {
    await fs.writeFile(claudeJson(), '{ not json');
    const status = await install();
    expect(status.errors).toHaveLength(1);
    expect(status.errors?.[0]).toMatch(/^Claude Code: .*not valid JSON/);
    expect(await fs.readFile(claudeJson(), 'utf8')).toBe('{ not json');
    expect(status.agents.find((a) => a.agent === 'codex')?.tokenPrefix).toBe(TOKEN.slice(0, 16));
  });

  it("never replaces the person's own skill with the same name", async () => {
    const own = path.join(home, '.claude', 'skills', LOCAL_SKILL_PACK[0].name);
    await fs.mkdir(own, { recursive: true });
    await fs.writeFile(path.join(own, 'SKILL.md'), 'mine');
    const status = await install(['claude']);
    const claude = status.agents.find((a) => a.agent === 'claude');
    expect(claude?.blockedSkills).toEqual([LOCAL_SKILL_PACK[0].name]);
    expect(await fs.readFile(path.join(own, 'SKILL.md'), 'utf8')).toBe('mine');
  });

  it('replaces the token on reconnect', async () => {
    await install();
    const status = await install(undefined, TOKEN_2);
    expect(status.agents.map((a) => a.tokenPrefix)).toEqual([TOKEN_2.slice(0, 16), TOKEN_2.slice(0, 16)]);
    const toml = await fs.readFile(codexToml(), 'utf8');
    expect(toml).not.toContain(TOKEN);
    expect(toml.match(/\[mcp_servers\.talyn\]/g)).toHaveLength(1);
  });

  it('removes stamped skills that left the pack', async () => {
    const old = path.join(home, '.codex', 'skills', 'talyn-retired');
    await fs.mkdir(old, { recursive: true });
    await fs.writeFile(path.join(old, LOCAL_SKILL_STAMP), '');
    await install(['codex']);
    await expect(fs.stat(old)).rejects.toThrow();
  });

  it.each([
    ['a token of another kind', { endpoint: ENDPOINT, token: 'ghp_abc', agents: ['claude'] }],
    ['a token with a quote', { endpoint: ENDPOINT, token: 'talyn_mcp_abcdefabcdefabcdef"x', agents: ['claude'] }],
    ['an endpoint that is not a URL', { endpoint: 'prod.talyn.dev', token: TOKEN, agents: ['claude'] }],
    ['a file endpoint', { endpoint: 'file:///etc/passwd', token: TOKEN, agents: ['claude'] }],
    ['no agents', { endpoint: ENDPOINT, token: TOKEN, agents: [] }],
    ['an unknown agent', { endpoint: ENDPOINT, token: TOKEN, agents: ['cursor'] }],
  ])('refuses %s and writes nothing', async (_label, req) => {
    await expect(installLocalAgentKit(req as never, home)).rejects.toThrow();
    await expect(fs.stat(claudeJson())).rejects.toThrow();
  });
});

describe('removeLocalAgentKit', () => {
  it("removes Talyn's server and skills, and keeps everything of the person's", async () => {
    await fs.writeFile(claudeJson(), JSON.stringify({ mcpServers: { context7: { url: 'https://c7' } } }));
    await fs.mkdir(path.join(home, '.codex'), { recursive: true });
    await fs.writeFile(codexToml(), 'model = "gpt-5"\n');
    const own = path.join(home, '.claude', 'skills', 'my-skill');
    await fs.mkdir(own, { recursive: true });
    await fs.writeFile(path.join(own, 'SKILL.md'), 'mine');
    await install();

    const status = await removeLocalAgentKit(['claude', 'codex'], home);
    expect(status.errors).toEqual([]);
    for (const agent of status.agents) {
      expect(agent).toMatchObject({ mcpUrl: null, tokenPrefix: null, skills: [] });
    }
    expect((await readJson()).mcpServers).toEqual({ context7: { url: 'https://c7' } });
    expect(await fs.readFile(codexToml(), 'utf8')).toBe('model = "gpt-5"\n');
    expect(await fs.readFile(path.join(own, 'SKILL.md'), 'utf8')).toBe('mine');
  });

  it('creates nothing on a machine with no config', async () => {
    await removeLocalAgentKit(['claude', 'codex'], home);
    expect(await fs.readdir(home)).toEqual([]);
  });
});

describe('refreshLocalSkills', () => {
  it('updates installed skills and leaves an agent that was never connected alone', async () => {
    await install(['claude']);
    const file = path.join(home, '.claude', 'skills', LOCAL_SKILL_PACK[0].name, 'SKILL.md');
    await fs.writeFile(file, 'an older version');
    await refreshLocalSkills(home);
    expect(await fs.readFile(file, 'utf8')).toBe(LOCAL_SKILL_PACK[0].content);
    await expect(fs.stat(path.join(home, '.codex'))).rejects.toThrow();
  });
});

describe('readLocalAgentKit', () => {
  it('detects an agent from its config directory', async () => {
    await fs.mkdir(path.join(home, '.codex'));
    const status = await readLocalAgentKit(home);
    expect(status.agents.map((a) => [a.agent, a.detected])).toEqual([
      ['claude', false],
      ['codex', true],
    ]);
    expect(status.pack).toEqual(LOCAL_SKILL_PACK.map((s) => s.name));
  });
});
