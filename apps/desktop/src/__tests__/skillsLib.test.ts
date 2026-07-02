import type { SkillSummary, SkillUsageEntry } from '@talyn/shared';
import { SKILL_MAX_BYTES } from '@talyn/shared';
import {
  toLocalSkillSummaries,
  sortSkillsForPicker,
  frequentlyUsedSkills,
  isSkillTooLarge,
} from '../renderer/lib/skills';
import type { LocalSkillFile } from '../main/preload';

const file = (over: Partial<LocalSkillFile> = {}): LocalSkillFile => ({
  dirName: 'my-skill',
  path: '/home/u/.claude/skills/my-skill/SKILL.md',
  size: 100,
  mtimeMs: 0,
  content: '---\nname: my-skill\ndescription: Does things\n---\n\nBody',
  ...over,
});

const skill = (over: Partial<SkillSummary> = {}): SkillSummary => ({
  key: `local:${over.name ?? 's'}`,
  source: 'local',
  name: 's',
  description: '',
  ...over,
});

const used = (count: number, lastUsedAt = '2026-07-01T00:00:00Z'): SkillUsageEntry => ({
  count,
  lastUsedAt,
});

describe('toLocalSkillSummaries', () => {
  it('parses frontmatter into name/description and builds local keys', () => {
    const [s] = toLocalSkillSummaries([file()]);
    expect(s.key).toBe('local:my-skill');
    expect(s.name).toBe('my-skill');
    expect(s.description).toBe('Does things');
    expect(s.localPath).toBe('/home/u/.claude/skills/my-skill/SKILL.md');
    expect(s.contentSize).toBe(100);
  });

  it('falls back to the directory name without frontmatter', () => {
    const [s] = toLocalSkillSummaries([file({ content: 'no frontmatter', dirName: 'plain' })]);
    expect(s.name).toBe('plain');
    expect(s.description).toBe('');
  });

  it('keeps the first occurrence when names collide', () => {
    const out = toLocalSkillSummaries([
      file({ path: '/a/SKILL.md' }),
      file({ path: '/b/SKILL.md', dirName: 'other-dir' }), // same frontmatter name
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].localPath).toBe('/a/SKILL.md');
  });

  it('still lists an oversized skill (content null) using the dir name', () => {
    const [s] = toLocalSkillSummaries([
      file({ content: null, size: SKILL_MAX_BYTES + 1, dirName: 'huge' }),
    ]);
    expect(s.name).toBe('huge');
    expect(isSkillTooLarge(s)).toBe(true);
  });
});

describe('sortSkillsForPicker', () => {
  const skills: SkillSummary[] = [
    skill({ name: 'zeta', key: 'local:zeta' }),
    skill({ name: 'alpha', key: 'local:alpha' }),
    skill({ name: 'review', key: 'platform:1', source: 'platform', id: '1' }),
    skill({ name: 'lint', key: 'repo:acme/w:lint', source: 'repo', repositoryId: 'r1' }),
  ];

  it('puts most-used first, recency as tiebreak, then groups never-used by source', () => {
    const usage = {
      'local:zeta': used(3),
      'platform:1': used(3, '2026-07-02T00:00:00Z'), // same count, more recent
      'repo:acme/w:lint': used(1),
    };
    const sorted = sortSkillsForPicker(skills, usage, '');
    expect(sorted.map((s) => s.key)).toEqual([
      'platform:1', // 3 uses, most recent
      'local:zeta', // 3 uses
      'repo:acme/w:lint', // 1 use
      'local:alpha', // never used (repo/platform/local order, only local left)
    ]);
  });

  it('orders never-used skills repo → platform → local, alphabetical within', () => {
    const sorted = sortSkillsForPicker(skills, {}, '');
    expect(sorted.map((s) => s.key)).toEqual([
      'repo:acme/w:lint',
      'platform:1',
      'local:alpha',
      'local:zeta',
    ]);
  });

  it('filters by name or description substring, case-insensitive', () => {
    const withDesc = [
      skill({ name: 'a', key: 'local:a', description: 'Checks for Bugs' }),
      skill({ name: 'BugFinder', key: 'local:BugFinder' }),
      skill({ name: 'other', key: 'local:other' }),
    ];
    const hits = sortSkillsForPicker(withDesc, {}, 'bug');
    expect(hits.map((s) => s.name).sort()).toEqual(['BugFinder', 'a']);
  });
});

describe('frequentlyUsedSkills', () => {
  it('returns only used skills, capped and ordered by count then recency', () => {
    const many = [
      skill({ name: 'a', key: 'local:a' }),
      skill({ name: 'b', key: 'local:b' }),
      skill({ name: 'c', key: 'local:c' }),
      skill({ name: 'd', key: 'local:d' }),
      skill({ name: 'e', key: 'local:e' }),
      skill({ name: 'never', key: 'local:never' }),
    ];
    const usage = {
      'local:a': used(1),
      'local:b': used(5),
      'local:c': used(3),
      'local:d': used(2),
      'local:e': used(4),
    };
    const top = frequentlyUsedSkills(many, usage);
    expect(top.map((s) => s.key)).toEqual(['local:b', 'local:e', 'local:c', 'local:d']);
  });

  it('returns empty when nothing has been used', () => {
    expect(frequentlyUsedSkills([skill()], {})).toEqual([]);
  });
});
