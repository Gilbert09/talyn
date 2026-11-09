import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { LOCAL_SKILL_PACK, type LocalSkill } from './localSkillPack';

/**
 * Connect Claude Code and Codex on THIS computer to Talyn in one click: the
 * `talyn` MCP server (the hosted endpoint plus a personal token) and the local
 * skill pack (`localSkillPack.ts`).
 *
 * # What is written
 *
 * - Claude Code: `mcpServers.talyn` at the top level (user scope) of
 *   `~/.claude.json`, and `~/.claude/skills/<name>/SKILL.md`.
 * - Codex: a `[mcp_servers.talyn]` table in `~/.codex/config.toml` with a
 *   static `http_headers` Authorization, and `~/.codex/skills/<name>/SKILL.md`.
 *
 * # What is never touched
 *
 * Everything else in those files is kept as it is. A skill directory without
 * Talyn's stamp file belongs to the person: it is never written or removed,
 * and is reported as blocked. A config that does not parse is refused rather
 * than replaced. A config that is a symlink (a dotfiles repo) is written
 * through the link, so the link stays.
 *
 * # Where the token goes
 *
 * The renderer mints the token and hands it here once. It is written to the
 * two config files (mode 0600) and never comes back over IPC: the status
 * reports only the display prefix, which is how the settings page matches an
 * install to a row in the token list.
 */

export type LocalAgent = 'claude' | 'codex';
export const LOCAL_AGENTS: readonly LocalAgent[] = ['claude', 'codex'];

export const LOCAL_MCP_NAME = 'talyn';
/** In a skill's directory: this directory is Talyn's to replace and remove. */
export const LOCAL_SKILL_STAMP = '.talyn-local-skill';
const STAMP_TEXT =
  'Installed by the Talyn desktop app. Talyn replaces this directory on update and removes it on disconnect.\n';
export const CODEX_MARKER = '# Managed by the Talyn desktop app (Settings → MCP server).';

const TOKEN_PATTERN = /^talyn_mcp_[A-Za-z0-9_-]{16,}$/;
/** `talyn_mcp_` plus the 6 characters the backend keeps in `token_prefix`. */
const TOKEN_PREFIX_CHARS = 16;

export interface LocalAgentState {
  agent: LocalAgent;
  /** The agent's config directory or file exists on this computer. */
  detected: boolean;
  /** The URL of the configured `talyn` server, or null when there is none. */
  mcpUrl: string | null;
  /** Display head of the configured token (`talyn_mcp_ab12cd`). Never the token. */
  tokenPrefix: string | null;
  /** Pack skills installed by Talyn. */
  skills: string[];
  /** Pack skills that a skill of the person's own, with the same name, blocks. */
  blockedSkills: string[];
}

export interface LocalAgentKitStatus {
  hostname: string;
  /** Names of the skills this build installs. */
  pack: string[];
  agents: LocalAgentState[];
  /** From an install or a remove: what failed, one line per agent. */
  errors?: string[];
}

export interface InstallLocalAgentKitRequest {
  endpoint: string;
  token: string;
  agents: LocalAgent[];
}

interface AgentPaths {
  detect: string[];
  config: string;
  skills: string;
}

function agentPaths(agent: LocalAgent, home: string): AgentPaths {
  if (agent === 'claude') {
    return {
      detect: [path.join(home, '.claude'), path.join(home, '.claude.json')],
      config: path.join(home, '.claude.json'),
      skills: path.join(home, '.claude', 'skills'),
    };
  }
  return {
    detect: [path.join(home, '.codex')],
    config: path.join(home, '.codex', 'config.toml'),
    skills: path.join(home, '.codex', 'skills'),
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Replace `file` atomically. A symlink is followed, so a config kept in a
 * dotfiles repo stays a link. The new file drops group and other access,
 * because it now holds a token.
 */
async function writeSecretFile(file: string, text: string): Promise<void> {
  let target = file;
  try {
    target = await fs.realpath(file);
  } catch {
    // Not there yet.
  }
  let mode = 0o600;
  try {
    mode = (await fs.stat(target)).mode & 0o700;
  } catch {
    // New file.
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.talyn-${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, text, { mode: mode || 0o600 });
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

function tokenPrefixOf(authorization: unknown): string | null {
  if (typeof authorization !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/.exec(authorization.trim());
  return m ? m[1].slice(0, TOKEN_PREFIX_CHARS) : null;
}

// ---------------------------------------------------------------------------
// Claude Code: ~/.claude.json

function parseClaudeJson(text: string | null): Record<string, unknown> {
  if (text === null || text.trim() === '') return {};
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('~/.claude.json is not valid JSON, so Talyn did not change it.');
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new Error('~/.claude.json is not a JSON object, so Talyn did not change it.');
  }
  return doc as Record<string, unknown>;
}

function claudeServers(doc: Record<string, unknown>): Record<string, unknown> {
  const servers = doc.mcpServers;
  return typeof servers === 'object' && servers !== null && !Array.isArray(servers)
    ? (servers as Record<string, unknown>)
    : {};
}

async function readClaudeServer(file: string): Promise<{ url: string | null; tokenPrefix: string | null }> {
  try {
    const entry = claudeServers(parseClaudeJson(await readText(file)))[LOCAL_MCP_NAME] as
      | { url?: unknown; headers?: Record<string, unknown> }
      | undefined;
    if (!entry || typeof entry !== 'object') return { url: null, tokenPrefix: null };
    return {
      url: typeof entry.url === 'string' ? entry.url : null,
      tokenPrefix: tokenPrefixOf(entry.headers?.Authorization),
    };
  } catch {
    return { url: null, tokenPrefix: null };
  }
}

async function writeClaudeServer(file: string, server: { url: string; token: string } | null): Promise<void> {
  const text = await readText(file);
  if (text === null && server === null) return;
  const doc = parseClaudeJson(text);
  const servers = { ...claudeServers(doc) };
  if (server) {
    servers[LOCAL_MCP_NAME] = {
      type: 'http',
      url: server.url,
      headers: { Authorization: `Bearer ${server.token}` },
    };
  } else {
    if (!(LOCAL_MCP_NAME in servers)) return;
    delete servers[LOCAL_MCP_NAME];
  }
  doc.mcpServers = servers;
  await writeSecretFile(file, `${JSON.stringify(doc, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Codex: ~/.codex/config.toml, edited as lines.
//
// A TOML library would reformat the person's whole file on write. Only one
// table is ours, so the edit removes that table (and its sub-tables) and
// appends a fresh one; every other line is kept byte for byte.

/** `[ mcp_servers . "talyn" ]` → `mcp_servers.talyn`. Null when the line is not a table header. */
function tableKey(line: string): string | null {
  const m = /^\s*\[\[?([^\]]*)\]\]?\s*(#.*)?$/.exec(line);
  return m ? m[1].replace(/\s+/g, '').replace(/["']/g, '') : null;
}

const OUR_TABLE = `mcp_servers.${LOCAL_MCP_NAME}`;

export function removeCodexServer(text: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const out: string[] = [];
  let table = '';
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    const key = tableKey(line);
    if (key !== null) {
      table = key;
      skipping = key === OUR_TABLE || key.startsWith(`${OUR_TABLE}.`);
      if (skipping) {
        if (out.length > 0 && out[out.length - 1].trim() === CODEX_MARKER) out.pop();
        continue;
      }
    }
    if (skipping) continue;
    if (line.trim() === CODEX_MARKER) continue;
    // The same server written as a key rather than a table header.
    if (table === 'mcp_servers' && /^\s*["']?talyn["']?\s*[.=]/.test(line)) continue;
    if (table === '' && /^\s*mcp_servers\s*\.\s*["']?talyn["']?\s*[.=]/.test(line)) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out.length > 0 ? `${out.join(eol)}${eol}` : '';
}

export function addCodexServer(text: string, url: string, token: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const rest = removeCodexServer(text);
  // A JSON string literal is a valid TOML basic string for these values.
  const block = [
    CODEX_MARKER,
    `[${OUR_TABLE}]`,
    `url = ${JSON.stringify(url)}`,
    `http_headers = { Authorization = ${JSON.stringify(`Bearer ${token}`)} }`,
  ].join(eol);
  return `${rest}${rest ? eol : ''}${block}${eol}`;
}

export function readCodexServer(text: string): { url: string | null; tokenPrefix: string | null } {
  let inOurs = false;
  let url: string | null = null;
  let tokenPrefix: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const key = tableKey(line);
    if (key !== null) {
      inOurs = key === OUR_TABLE;
      continue;
    }
    if (!inOurs) continue;
    const u = /^\s*url\s*=\s*"([^"]*)"/.exec(line);
    if (u) url = u[1];
    const auth = /Authorization["']?\s*=\s*"([^"]*)"/.exec(line);
    if (auth) tokenPrefix = tokenPrefixOf(auth[1]);
  }
  return { url, tokenPrefix };
}

async function writeCodexServer(file: string, server: { url: string; token: string } | null): Promise<void> {
  const text = await readText(file);
  if (text === null && server === null) return;
  const next = server ? addCodexServer(text ?? '', server.url, server.token) : removeCodexServer(text ?? '');
  if (next === text) return;
  await writeSecretFile(file, next);
}

// ---------------------------------------------------------------------------
// Skills

async function isStamped(dir: string): Promise<boolean> {
  return exists(path.join(dir, LOCAL_SKILL_STAMP));
}

async function stampedDirs(root: string): Promise<string[]> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && (await isStamped(path.join(root, entry.name)))) out.push(entry.name);
  }
  return out.sort();
}

async function skillState(root: string): Promise<{ skills: string[]; blockedSkills: string[] }> {
  const stamped = new Set(await stampedDirs(root));
  const skills: string[] = [];
  const blockedSkills: string[] = [];
  for (const { name } of LOCAL_SKILL_PACK) {
    if (stamped.has(name)) skills.push(name);
    else if (await exists(path.join(root, name))) blockedSkills.push(name);
  }
  return { skills, blockedSkills };
}

async function writeSkill(root: string, skill: LocalSkill): Promise<void> {
  const dir = path.join(root, skill.name);
  if ((await exists(dir)) && !(await isStamped(dir))) return; // the person's own
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  if ((await readText(file)) !== skill.content) await fs.writeFile(file, skill.content);
  await fs.writeFile(path.join(dir, LOCAL_SKILL_STAMP), STAMP_TEXT);
}

/** Write the pack into `root`, and remove stamped skills that left the pack. */
async function syncSkills(root: string, pack: readonly LocalSkill[]): Promise<void> {
  const names = new Set(pack.map((s) => s.name));
  for (const name of await stampedDirs(root)) {
    if (!names.has(name)) await fs.rm(path.join(root, name), { recursive: true, force: true });
  }
  for (const skill of pack) await writeSkill(root, skill);
}

// ---------------------------------------------------------------------------
// Public API

function homeOf(homeDir?: string): string {
  // The parameter exists for the tests. The main process passes nothing.
  return homeDir ?? os.homedir();
}

export async function readLocalAgentKit(homeDir?: string): Promise<LocalAgentKitStatus> {
  const home = homeOf(homeDir);
  const agents = await Promise.all(
    LOCAL_AGENTS.map(async (agent): Promise<LocalAgentState> => {
      const p = agentPaths(agent, home);
      const detected = (await Promise.all(p.detect.map(exists))).some(Boolean);
      const server =
        agent === 'claude'
          ? await readClaudeServer(p.config)
          : readCodexServer((await readText(p.config).catch(() => null)) ?? '');
      return { agent, detected, mcpUrl: server.url, tokenPrefix: server.tokenPrefix, ...(await skillState(p.skills)) };
    })
  );
  return { hostname: os.hostname(), pack: LOCAL_SKILL_PACK.map((s) => s.name), agents };
}

function validate(req: InstallLocalAgentKitRequest): void {
  let url: URL;
  try {
    url = new URL(req.endpoint);
  } catch {
    throw new Error('The MCP endpoint is not a URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The MCP endpoint must be an http or https URL.');
  }
  if (!TOKEN_PATTERN.test(req.token)) throw new Error('That is not a Talyn MCP token.');
  if (req.agents.length === 0 || req.agents.some((a) => !LOCAL_AGENTS.includes(a))) {
    throw new Error('Choose Claude Code, Codex or both.');
  }
}

const agentLabel = (agent: LocalAgent) => (agent === 'claude' ? 'Claude Code' : 'Codex');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Configure each agent in `req.agents`. Every agent is tried, also when one
 * fails, and the failures come back in `errors`, so a broken `~/.claude.json`
 * does not stop Codex from connecting. The caller compares the token prefixes
 * in the result to see which agents now hold the new token.
 */
export async function installLocalAgentKit(
  req: InstallLocalAgentKitRequest,
  homeDir?: string
): Promise<LocalAgentKitStatus> {
  validate(req);
  const home = homeOf(homeDir);
  const errors: string[] = [];
  for (const agent of req.agents) {
    const p = agentPaths(agent, home);
    try {
      const server = { url: req.endpoint, token: req.token };
      if (agent === 'claude') await writeClaudeServer(p.config, server);
      else await writeCodexServer(p.config, server);
      await syncSkills(p.skills, LOCAL_SKILL_PACK);
    } catch (e) {
      errors.push(`${agentLabel(agent)}: ${message(e)}`);
    }
  }
  return { ...(await readLocalAgentKit(homeDir)), errors };
}

/** Remove the `talyn` server and every stamped skill. The person's own skills stay. */
export async function removeLocalAgentKit(agents: LocalAgent[], homeDir?: string): Promise<LocalAgentKitStatus> {
  const home = homeOf(homeDir);
  const errors: string[] = [];
  for (const agent of agents.filter((a) => LOCAL_AGENTS.includes(a))) {
    const p = agentPaths(agent, home);
    try {
      if (agent === 'claude') await writeClaudeServer(p.config, null);
      else await writeCodexServer(p.config, null);
      await syncSkills(p.skills, []);
    } catch (e) {
      errors.push(`${agentLabel(agent)}: ${message(e)}`);
    }
  }
  return { ...(await readLocalAgentKit(homeDir)), errors };
}

/**
 * On app start: bring installed skills up to the version this build carries.
 * Only a skills root that already holds a stamped skill is touched, so an
 * agent the person never connected gets nothing.
 */
export async function refreshLocalSkills(homeDir?: string): Promise<void> {
  const home = homeOf(homeDir);
  for (const agent of LOCAL_AGENTS) {
    const root = agentPaths(agent, home).skills;
    if ((await stampedDirs(root)).length > 0) await syncSkills(root, LOCAL_SKILL_PACK);
  }
}
