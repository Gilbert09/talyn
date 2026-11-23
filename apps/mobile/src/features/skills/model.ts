import type { CreatePlatformSkillRequest, ListSkillsResponse, PlatformSkill, SkillSummary, UpdatePlatformSkillRequest } from '@talyn/shared';

export const SKILLS_INTRO = "Agent skills (SKILL.md) you can run on a pull request with a cloud task. They come from this workspace, your computer, or the PR's repo.";
export const LOCAL_SKILLS_NOTE = 'Local skills live in ~/.claude/skills on your computer. A phone cannot read them. Manage them in the Talyn desktop app.';
export const NO_PLATFORM_SKILLS = 'No skills saved to Talyn yet. Create one here, or save a local skill from the desktop app.';
export const DELETE_SKILL_TITLE = 'Delete this skill?';
export const NAME_AND_CONTENT_REQUIRED = 'Name and content are required';
export const SKILL_CONTENT_PLACEHOLDER = '---\nname: pr-review\ndescription: …\n---\n\nInstructions…';

export function deleteSkillMessage(name: string): string {
  return `${name} is removed from this workspace. Tasks that already ran with it are unaffected.`;
}

/** Talyn skills and the selected repository's skills. Local skills never come from the server. */
export function splitSkills(response: ListSkillsResponse | null | undefined): { platform: SkillSummary[]; repo: SkillSummary[] } {
  return {
    platform: (response?.platform ?? []).filter((skill) => skill.source === 'platform'),
    repo: (response?.repo ?? []).filter((skill) => skill.source === 'repo'),
  };
}

/** The chosen repository when it is still in the workspace, else the first one. */
export function selectedRepositoryId(repositories: ReadonlyArray<{ id: string }>, selected: string | null): string | null {
  if (selected && repositories.some((repo) => repo.id === selected)) return selected;
  return repositories[0]?.id ?? null;
}

/** Why the repository section has no list, or null when it has skills to show. */
export function repoSkillsMessage(repositoryCount: number, response: Pick<ListSkillsResponse, 'repoStatus'> | null | undefined, repoSkills: readonly SkillSummary[]): string | null {
  if (repositoryCount === 0) return 'No repositories in this workspace.';
  if (response?.repoStatus === 'error') return 'Could not load skills from GitHub. Try refreshing.';
  if (repoSkills.length === 0) return 'No skills in this repo. Talyn looked in .claude/skills on the default branch.';
  return null;
}

export function skillSubtitle(skill: Pick<SkillSummary, 'description' | 'repoPath'>): string | undefined {
  return skill.description || skill.repoPath || undefined;
}

export interface SkillDraft { name: string; description: string; content: string }

export function skillDraftOf(skill?: Pick<PlatformSkill, 'name' | 'description' | 'content'> | null): SkillDraft {
  return { name: skill?.name ?? '', description: skill?.description ?? '', content: skill?.content ?? '' };
}

/** The check web runs before it sends: a name and content. */
export function skillDraftError(draft: SkillDraft): string | null {
  return !draft.name.trim() || !draft.content.trim() ? NAME_AND_CONTENT_REQUIRED : null;
}

export function skillDirty(original: SkillDraft | null, draft: SkillDraft): boolean {
  if (!original) return Boolean(draft.name.trim() || draft.description.trim() || draft.content.trim());
  return draft.name !== original.name || draft.description !== original.description || draft.content !== original.content;
}

export function skillCreateRequest(workspaceId: string, draft: SkillDraft): CreatePlatformSkillRequest {
  return { workspaceId, name: draft.name, description: draft.description, content: draft.content };
}

export function skillUpdateRequest(draft: SkillDraft): UpdatePlatformSkillRequest {
  return { name: draft.name, description: draft.description, content: draft.content };
}

export function skillSaveFailureTitle(editing: boolean): string {
  return editing ? 'Could not update skill' : 'Could not create skill';
}
