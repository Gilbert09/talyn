// Agent skills — SKILL.md files a user can run against a PR via a cloud task.
//
// Skills come from three sources:
//   - `repo`:     `.claude/skills/<name>/SKILL.md` in the PR's repository,
//                 discovered server-side via the GitHub contents API
//   - `local`:    `~/.claude/skills/<name>/SKILL.md` on the user's machine,
//                 read by the desktop main process over IPC
//   - `platform`: skills saved to Talyn (workspace-scoped `skills` table)
//
// Neither cloud provider (PostHog Code / Claude Code) accepts skills or file
// mounts natively, so a skill's content is inlined into the task prompt —
// see `skillPrompt.ts`.

export type SkillSource = 'repo' | 'local' | 'platform';

/**
 * Canonical skill identity, namespaced by source so usage stats can't
 * collide across sources:
 *   repo:<owner>/<repo>:<name>  |  local:<name>  |  platform:<id>
 */
export type SkillKey = string;

export function repoSkillKey(owner: string, repo: string, name: string): SkillKey {
  return `repo:${owner}/${repo}:${name}`;
}

export function localSkillKey(name: string): SkillKey {
  return `local:${name}`;
}

export function platformSkillKey(id: string): SkillKey {
  return `platform:${id}`;
}

/** A skill key, taken apart. `null` for a key in none of the three formats. */
export type ParsedSkillKey =
  | { source: 'repo'; owner: string; repo: string; name: string }
  | { source: 'platform'; id: string }
  | { source: 'local'; name: string };

/**
 * Read a skill key back into its parts.
 *
 * A repo key is `repo:<owner>/<repo>:<name>`. The name is everything after the
 * SECOND colon, so a skill name that contains a colon still parses.
 */
export function parseSkillKey(key: unknown): ParsedSkillKey | null {
  if (typeof key !== 'string') return null;
  if (key.startsWith('platform:')) {
    const id = key.slice('platform:'.length);
    return id ? { source: 'platform', id } : null;
  }
  if (key.startsWith('local:')) {
    const name = key.slice('local:'.length);
    return name ? { source: 'local', name } : null;
  }
  if (key.startsWith('repo:')) {
    const rest = key.slice('repo:'.length);
    const sep = rest.indexOf(':');
    if (sep < 0) return null;
    const [owner, repo, ...extra] = rest.slice(0, sep).split('/');
    const name = rest.slice(sep + 1);
    if (!owner || !repo || extra.length || !name) return null;
    return { source: 'repo', owner, repo, name };
  }
  return null;
}

/**
 * Hard ceiling on a skill's SKILL.md size. Skills are NEVER truncated — a
 * silently clipped skill changes its meaning — so anything over this is
 * listed but refused at run time ("too large to run"). The guard exists
 * because the content is inlined into `tasks.prompt` (stored and shipped on
 * every task read — DB egress), rides through JSON request bodies, and eats
 * the cloud agent's context. Real skills are 1–10KB; this should never fire.
 */
export const SKILL_MAX_BYTES = 256 * 1024;

/** A skill as listed in the picker / Settings. Content is fetched separately. */
export interface SkillSummary {
  key: SkillKey;
  source: SkillSource;
  /** Frontmatter `name`, falling back to the skill's directory name. */
  name: string;
  /** Frontmatter `description`; may be empty. */
  description: string;
  /** platform only — the `skills` row id. */
  id?: string;
  /** repo only — the watched repository the skill was discovered in. */
  repositoryId?: string;
  /** repo only — path inside the repo, e.g. `.claude/skills/foo/SKILL.md`. */
  repoPath?: string;
  /** repo only — SKILL.md has sibling files the agent can read from its checkout. */
  hasSupportingFiles?: boolean;
  /** local only — absolute path of SKILL.md on the user's machine. */
  localPath?: string;
  /** Bytes of SKILL.md; over {@link SKILL_MAX_BYTES} the skill can't run. */
  contentSize?: number;
}

export interface SkillUsageEntry {
  count: number;
  /** ISO timestamp of the most recent run. */
  lastUsedAt: string;
}

/** Result of parsing a SKILL.md: frontmatter fields + the markdown body. */
export interface ParsedSkill {
  name?: string;
  description?: string;
  body: string;
}

/**
 * Tolerant parser for the flat `key: value` YAML frontmatter real skills use.
 * Not a YAML implementation on purpose: nested structures are ignored rather
 * than mis-parsed, unknown keys are skipped, and a file with no frontmatter
 * block is all body.
 */
export function parseSkillFrontmatter(raw: string): ParsedSkill {
  const text = raw.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!match) return { body: text };

  const block = match[1];
  const body = text.slice(match[0].length).replace(/^\n/, '');
  const out: ParsedSkill = { body };

  for (const line of block.split('\n')) {
    const m = /^(name|description)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (value) out[m[1] as 'name' | 'description'] = value;
  }
  return out;
}
