import {
  CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES, codeReviewLensLabel, codeReviewLensNames, codeReviewReviewersProblem, customReviewerSource,
  parseSkillKey, resolveCodeReviewSettings,
  type CodeReviewCustomReviewer, type CodeReviewLensStat, type CodeReviewSettings, type ListSkillsResponse,
  type ResolvedCodeReviewSettings, type SkillSummary, type SkillUsageEntry, type Workspace,
} from '@talyn/shared';

// Pure parts of the code review settings screen. Each one ports a rule from
// web `CodeReviewSettingsCard.tsx` or `ReviewersSettings.tsx`.

/** The settings as saved, with a change that is still saving laid over them. */
export function codeReviewSettingsOf(stored: CodeReviewSettings | null | undefined, pending: CodeReviewSettings = {}): ResolvedCodeReviewSettings {
  return resolveCodeReviewSettings({ ...(stored ?? {}), ...pending });
}

/**
 * The body for `workspaces.update`. Only the changed key goes: the route
 * deep-merges `codeReview`, so the other keys stay as they are.
 */
export function codeReviewPatchBody(patch: CodeReviewSettings): Partial<Workspace> {
  return { settings: { codeReview: patch } as Workspace['settings'] };
}

/** The step's badge: whose reviewers read a pull request. Web `reviewersBadge`. */
export function reviewersBadge(builtIn: boolean, custom: number): string {
  if (!custom) return builtIn ? "Talyn's" : 'None';
  const own = `${custom} of your own`;
  return builtIn ? `Talyn's and ${own}` : own;
}

export interface ReviewerProblems {
  /** Why Talyn's reviewers cannot be turned off now, or null. */
  off: string | null;
  /** Why the only custom reviewer cannot be removed now, or null. */
  removeLast: string | null;
}

/** What each change would leave behind, asked of the rule the route applies. */
export function reviewerProblems(settings: Pick<ResolvedCodeReviewSettings, 'builtInReviewers' | 'customReviewers'>): ReviewerProblems {
  const reviewers = settings.customReviewers;
  return {
    off: settings.builtInReviewers ? codeReviewReviewersProblem({ builtInReviewers: false, customReviewers: reviewers }) : null,
    removeLast: reviewers.length === 1
      ? codeReviewReviewersProblem({ builtInReviewers: settings.builtInReviewers, customReviewers: [] })
      : null,
  };
}

/** Why a skill cannot be chosen as a reviewer, or null when it can. Web `reviewerSkillRefusal`. */
export function reviewerSkillRefusal(skill: Pick<SkillSummary, 'key' | 'source' | 'contentSize'>,
  added: readonly CodeReviewCustomReviewer[]): string | null {
  if (skill.source === 'local') return 'On this machine only. Talyn runs reviews on its servers.';
  if (added.some((reviewer) => reviewer.skillKey === skill.key)) return 'Already a reviewer';
  if ((skill.contentSize ?? 0) > CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES) return 'Too large to run as a reviewer';
  return null;
}

export const addReviewerPatch = (reviewers: readonly CodeReviewCustomReviewer[], skill: Pick<SkillSummary, 'key' | 'name'>): CodeReviewSettings =>
  ({ customReviewers: [...reviewers, { skillKey: skill.key, name: skill.name }] });

export const removeReviewerPatch = (reviewers: readonly CodeReviewCustomReviewer[], skillKey: string): CodeReviewSettings =>
  ({ customReviewers: reviewers.filter((reviewer) => reviewer.skillKey !== skillKey) });

export interface ReviewerRow {
  skillKey: string;
  name: string;
  repo: boolean;
  /** "owner/repo" or "Talyn skill". */
  source: string;
  /** For a repository skill: where it runs. */
  scope: string | null;
}

export function reviewerRows(reviewers: readonly CodeReviewCustomReviewer[]): ReviewerRow[] {
  return reviewers.map((reviewer) => {
    const repo = parseSkillKey(reviewer.skillKey)?.source === 'repo';
    const source = customReviewerSource(reviewer.skillKey);
    return { skillKey: reviewer.skillKey, name: reviewer.name, repo, source,
      scope: repo ? `Runs on pull requests in ${source} only.` : null };
  });
}

export interface LensStatRow { lens: string; label: string; kept: number; raised: number; percent: number; text: string }

/** "How each reviewer has done here", with this workspace's own reviewers named. */
export function lensStatRows(stats: readonly CodeReviewLensStat[], reviewers: readonly CodeReviewCustomReviewer[]): LensStatRow[] {
  const names = codeReviewLensNames(reviewers);
  return stats.map((stat) => ({
    lens: stat.lens, label: codeReviewLensLabel(stat.lens, names), kept: stat.kept, raised: stat.raised,
    percent: stat.raised ? Math.round((stat.kept / stat.raised) * 100) : 0,
    text: `${stat.kept} of ${stat.raised} kept`,
  }));
}

const SOURCE_ORDER: Record<SkillSummary['source'], number> = { repo: 0, platform: 1, local: 2 };

/**
 * Filter by name or description and order for the picker: most used first,
 * then most recent, then by source and name. Web `sortSkillsForPicker`.
 */
export function sortSkillsForPicker(skills: readonly SkillSummary[], usage: Readonly<Record<string, SkillUsageEntry>>, query: string): SkillSummary[] {
  const q = query.trim().toLowerCase();
  const filtered = q ? skills.filter((skill) => skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q)) : [...skills];
  return filtered.sort((a, b) => {
    const ua = usage[a.key];
    const ub = usage[b.key];
    if ((ub?.count ?? 0) !== (ua?.count ?? 0)) return (ub?.count ?? 0) - (ua?.count ?? 0);
    if (ua && ub && ua.lastUsedAt !== ub.lastUsedAt) return ub.lastUsedAt.localeCompare(ua.lastUsedAt);
    if (SOURCE_ORDER[a.source] !== SOURCE_ORDER[b.source]) return SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
    return a.name.localeCompare(b.name);
  });
}

export interface SkillGroup { key: SkillSummary['source']; title: string; skills: SkillSummary[] }

/** The picker's groups, like web: the repository's skills, Talyn's, then the machine's. Empty groups are dropped. */
export function skillGroups(response: Pick<ListSkillsResponse, 'repo' | 'platform' | 'usage'> | null | undefined, repoName: string | null,
  query: string): SkillGroup[] {
  if (!response) return [];
  const sorted = sortSkillsForPicker([...response.repo, ...response.platform], response.usage ?? {}, query);
  const groups: SkillGroup[] = [
    { key: 'repo', title: repoName ? `In ${repoName}` : 'In the repository', skills: sorted.filter((skill) => skill.source === 'repo') },
    { key: 'platform', title: 'On Talyn', skills: sorted.filter((skill) => skill.source === 'platform') },
    { key: 'local', title: 'On this machine', skills: sorted.filter((skill) => skill.source === 'local') },
  ];
  return groups.filter((group) => group.skills.length > 0);
}

/** What the picker says when it has no skill to show. */
export function emptySkillsText(query: string): string {
  return query.trim() ? 'No skills match your search.'
    : 'No skills found. Commit one under .claude/skills in the repository, or add one in Settings, Skills.';
}

/** The warning when the repository's skills did not load. */
export function repoSkillsError(response: Pick<ListSkillsResponse, 'repoStatus' | 'repoError'> | null | undefined): string | null {
  if (response?.repoStatus !== 'error') return null;
  return `Could not load this repository's skills${response.repoError ? `: ${response.repoError}` : ''}.`;
}
