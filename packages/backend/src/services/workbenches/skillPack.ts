import { readFileSync } from 'fs';
import path from 'path';
import { eq, sql } from 'drizzle-orm';
import { shellQuote, TALYN_SKILL_PACK } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { workspaces } from '../../db/schema.js';
import { shellPath, writeSandboxFiles, type SandboxFile } from './sandboxFiles.js';
import type { WorkbenchRow } from './store.js';

/**
 * Talyn's built-in skills for session sandboxes: how to use the `talyn` MCP
 * server and the box's GitHub access for multi-repo work, child sessions, CI,
 * shipping, review feedback and wrapping up.
 *
 * The text lives as Markdown beside this file (`skillPack/<name>/SKILL.md`)
 * and the build copies the directory into `dist` (`build:copy-assets`), so the
 * Docker image carries it with the compiled code.
 *
 * In the box, before each turn, each skill goes to both agents' skills roots:
 * Claude Code reads `~/.claude/skills/<name>/SKILL.md`, Codex CLI (0.159)
 * reads `$CODEX_HOME/skills/<name>/SKILL.md`, which is `~/.codex/skills`. A
 * stamp file in the skill's directory marks it as Talyn's: a directory without
 * one is the user's and is never written or removed. A file is rewritten only
 * when its bytes differ (`cmp`), so an unchanged pack costs one exec and no
 * writes. Switching the pack off, or a box without Talyn's MCP server, removes
 * every stamped directory on the next turn.
 */

export const SKILL_PACK_SOURCE_DIR = path.resolve(__dirname, 'skillPack');
export const CLAUDE_SKILLS_DIR = '~/.claude/skills';
export const CODEX_SKILLS_DIR = '~/.codex/skills';
export const SKILL_PACK_ROOTS = [CLAUDE_SKILLS_DIR, CODEX_SKILLS_DIR] as const;
/** In a skill's directory in the box: this directory is Talyn's to replace and remove. */
export const SKILL_PACK_STAMP = '.talyn-skill-pack';
const STAGING_DIR = '~/.talyn/skill-pack';
/** Codex refuses a longer skill description; Claude Code's limit is the same. */
export const MAX_SKILL_DESCRIPTION_CHARS = 1024;

export interface PackSkill {
  name: string;
  description: string;
  content: string;
}

/** The `name` and `description` of a SKILL.md's YAML frontmatter, or null when it has none. */
export function parseSkillFrontmatter(content: string): { name: string; description: string } | null {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content.replace(/\r\n/g, '\n'));
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  if (!fields.name || !fields.description) return null;
  return { name: fields.name, description: fields.description };
}

/** Read and check every skill in the pack. Throws when one is missing or malformed. */
export function readSkillPack(dir: string = SKILL_PACK_SOURCE_DIR): PackSkill[] {
  return TALYN_SKILL_PACK.map((name) => {
    const content = readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8');
    const meta = parseSkillFrontmatter(content);
    if (!meta) throw new Error(`skill pack: ${name}/SKILL.md has no name and description frontmatter`);
    if (meta.name !== name) throw new Error(`skill pack: ${name}/SKILL.md is named "${meta.name}"`);
    if (meta.description.length > MAX_SKILL_DESCRIPTION_CHARS) {
      throw new Error(`skill pack: ${name} description is ${meta.description.length} characters, over ${MAX_SKILL_DESCRIPTION_CHARS}`);
    }
    return { name, description: meta.description, content };
  });
}

let cached: PackSkill[] | null = null;

/** The pack, read once per process. */
export function loadSkillPack(): PackSkill[] {
  cached ??= readSkillPack();
  return cached;
}

/** Remove every stamped `talyn-*` skill under `root` whose name is not in `keep`. */
function removeStaleScript(root: string, keep: readonly string[]): string {
  const remove = `rm -f "$d"/SKILL.md "$d"/${SKILL_PACK_STAMP}; rmdir "$d" 2>/dev/null || true`;
  return [
    `for d in ${shellPath(root)}/talyn-*/; do`,
    '  d=${d%/}',
    `  [ -e "$d"/${SKILL_PACK_STAMP} ] || continue`,
    keep.length > 0 ? `  case "\${d##*/}" in ${keep.join('|')}) ;; *) ${remove} ;; esac` : `  ${remove}`,
    'done',
  ].join('\n');
}

/** Install one staged skill under `root`, unless a directory that is not Talyn's holds the name. */
function installScript(root: string, name: string): string {
  const d = `${shellPath(root)}/${shellQuote(name)}`;
  const src = `${shellPath(STAGING_DIR)}/${shellQuote(name)}/SKILL.md`;
  return [
    `d=${d}`,
    `if [ -e "$d" ] && [ ! -e "$d"/${SKILL_PACK_STAMP} ]; then`,
    `  echo "talyn skill pack: $d is not Talyn's; left alone" >&2`,
    'else',
    '  mkdir -p "$d"',
    `  if ! cmp -s ${src} "$d"/SKILL.md; then cp ${src} "$d"/SKILL.md.talyn-tmp && mv -f "$d"/SKILL.md.talyn-tmp "$d"/SKILL.md; fi`,
    `  [ -e "$d"/${SKILL_PACK_STAMP} ] || : > "$d"/${SKILL_PACK_STAMP}`,
    'fi',
  ].join('\n');
}

/**
 * The file to stage and the script that installs it. `skills` null means the
 * pack is off: nothing is staged and every stamped skill is removed.
 *
 * The skills travel as ONE file, cut apart in the box by byte offset, because
 * each staged file takes at least one env var and an exec carries four: six
 * files would cost a second exec on every turn.
 */
export function skillPackSyncPlan(skills: PackSkill[] | null): [SandboxFile[], { after: string }] {
  const list = skills ?? [];
  const bundle = shellPath(`${STAGING_DIR}/bundle`);
  const lines: string[] = [];
  const parts: Buffer[] = [];
  let offset = 0;
  for (const s of list) {
    const bytes = Buffer.from(s.content, 'utf8');
    const dir = `${shellPath(STAGING_DIR)}/${shellQuote(s.name)}`;
    lines.push(`mkdir -p ${dir}`, `head -c ${offset + bytes.length} ${bundle} | tail -c ${bytes.length} > ${dir}/SKILL.md`);
    parts.push(bytes);
    offset += bytes.length;
  }
  const keep = list.map((s) => s.name);
  for (const root of SKILL_PACK_ROOTS) {
    if (list.length > 0) lines.push(`mkdir -p ${shellPath(root)}`, ...list.map((s) => installScript(root, s.name)));
    lines.push(removeStaleScript(root, keep));
  }
  lines.push(`rm -rf ${shellPath(STAGING_DIR)}`);
  const files = list.length > 0 ? [{ path: `${STAGING_DIR}/bundle`, base64: Buffer.concat(parts).toString('base64') }] : [];
  return [files, { after: lines.join('\n') }];
}

/** `settings.sessionSkillPack`: on unless set to false. Reads one key, never the settings blob. */
export async function sessionSkillPackEnabled(workspaceId: string): Promise<boolean> {
  const [row] = await getPoolDbClient()
    .select({ value: sql<string | null>`${workspaces.settings} ->> 'sessionSkillPack'` })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row?.value !== 'false';
}

/**
 * Bring the box's skill pack in line with the workspace setting. The skills
 * describe the `talyn` MCP tools, so a box without that server gets none.
 * Returns whether the pack is installed after this turn's sync.
 */
export async function syncSkillPack(row: WorkbenchRow, opts: { talynTools: boolean }): Promise<boolean> {
  const enabled = opts.talynTools && (await sessionSkillPackEnabled(row.workspaceId));
  const [files, scripts] = skillPackSyncPlan(enabled ? loadSkillPack() : null);
  await writeSandboxFiles(row, files, scripts);
  return enabled;
}
