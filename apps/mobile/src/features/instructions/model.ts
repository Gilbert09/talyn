import type { PRRow } from '@talyn/client/native';
import {
  DEFAULT_PROMPT_TEMPLATES, MAX_REPOSITORY_INSTRUCTION_BYTES, PROMPT_KINDS, PROMPT_KIND_INFO, buildMergeablePrompt, buildSkillPrompt,
  defaultPromptTemplateHash, promptDefaultChangedSince, promptTemplateOverride, promptTemplateVariables, promptVariablesFor,
  validatePromptTemplate,
  type CloudProviderType, type PRMergeableSummary, type PromptKind, type PromptTemplateOverride, type PromptTemplateValidation,
  type PromptVariableGroup, type PromptVariableSpec, type RepositoryInstructionAgents, type RepositoryInstructionsSummary,
  type WorkspaceSettings,
} from '@talyn/shared';

// ---------------------------------------------------------------------------
// Repository instructions
// ---------------------------------------------------------------------------

export const REPOSITORY_INSTRUCTIONS_INTRO = 'Added to every session on this repository, for the agents you choose. Not committed.';
export const REPOSITORY_INSTRUCTIONS_PLACEHOLDER = 'Write markdown, for example how to run the tests or which style to follow.';

export const AGENT_OPTIONS: ReadonlyArray<{ value: RepositoryInstructionAgents; label: string }> = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'both', label: 'Both' },
];

export const AGENT_LABEL: Record<RepositoryInstructionAgents, string> = { claude: 'Claude', codex: 'Codex', both: 'Claude and Codex' };

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** "1.5 KB" under 10 KB, "12 KB" above, like web. */
export function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

export interface RepositoryInstructionsRow {
  id: string;
  fullName: string;
  set: boolean;
  /** "1.2 KB · Claude and Codex", or undefined when the repository has none. */
  detail?: string;
}

/** One row per repository of the workspace, marked when it has instructions. */
export function repositoryInstructionRows(
  repositories: ReadonlyArray<{ id: string; fullName: string; workspaceId?: string }>,
  summaries: readonly RepositoryInstructionsSummary[] | null | undefined,
  workspaceId: string | null,
): RepositoryInstructionsRow[] {
  const byRepo = new Map((summaries ?? []).map((summary) => [summary.repositoryId, summary]));
  return repositories.filter((repo) => !workspaceId || !repo.workspaceId || repo.workspaceId === workspaceId).map((repo) => {
    const summary = byRepo.get(repo.id);
    return { id: repo.id, fullName: repo.fullName, set: Boolean(summary),
      detail: summary ? `${kb(summary.bytes)} · ${AGENT_LABEL[summary.agents]}` : undefined };
  });
}

export interface RepositoryInstructionsDraft { body: string; agents: RepositoryInstructionAgents }

export interface RepositoryInstructionsCheck {
  bytes: number;
  tooLarge: boolean;
  empty: boolean;
  /** "1.2 KB of 64 KB". */
  count: string;
  dirty: boolean;
  canSave: boolean;
}

/** The editor's state: size, limit and whether Save is allowed. */
export function checkRepositoryInstructions(draft: RepositoryInstructionsDraft, saved: RepositoryInstructionsDraft | null): RepositoryInstructionsCheck {
  const bytes = byteLength(draft.body);
  const tooLarge = bytes > MAX_REPOSITORY_INSTRUCTION_BYTES;
  const empty = draft.body.trim() === '';
  const dirty = saved ? draft.body !== saved.body || draft.agents !== saved.agents : !empty;
  return { bytes, tooLarge, empty, count: `${kb(bytes)} of ${kb(MAX_REPOSITORY_INSTRUCTION_BYTES)}`, dirty,
    canSave: dirty && !tooLarge && !empty };
}

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

export const INSTRUCTIONS_INTRO = "The prompts Talyn hands to a cloud agent. Each starts from Talyn's default; customize one to replace it for this workspace. Anything in double braces, like {{pr.url}}, is filled in per run.";
export const STALE_DEFAULT_LINE = "Talyn's default for this prompt changed since you customized it.";
export const STALE_DEFAULT_DETAIL = "Talyn's default for this prompt changed since you customized it. Your version keeps working as written; check the Default tab if you want to pull anything in.";

type Settings = Pick<WorkspaceSettings, 'prompts'> | null | undefined;

export interface PromptCard {
  kind: PromptKind;
  label: string;
  usedFor: string;
  customized: boolean;
  stale: boolean;
  updatedAt?: string;
}

export function promptCards(settings: Settings): PromptCard[] {
  return PROMPT_KINDS.map((kind) => {
    const override = promptTemplateOverride(settings, kind);
    const info = PROMPT_KIND_INFO[kind];
    return { kind, label: info.label, usedFor: info.usedFor, customized: Boolean(override),
      stale: override ? promptDefaultChangedSince(override, kind) : false, updatedAt: override?.updatedAt };
  });
}

export function isPromptKind(value: unknown): value is PromptKind {
  return typeof value === 'string' && (PROMPT_KINDS as string[]).includes(value);
}

export interface PromptDraft { template: string; basedOnHash: string }

/** Where the editor starts: the override, or Talyn's default. */
export function initialPromptDraft(kind: PromptKind, override: PromptTemplateOverride | undefined): PromptDraft {
  return { template: override?.template ?? DEFAULT_PROMPT_TEMPLATES[kind], basedOnHash: override?.basedOnHash ?? defaultPromptTemplateHash(kind) };
}

export interface PromptEditorState {
  validation: PromptTemplateValidation;
  used: Set<string>;
  dirty: boolean;
  isDefaultText: boolean;
  staleDefault: boolean;
  canSave: boolean;
  saveLabel: string;
  chars: string;
}

export function promptEditorState(kind: PromptKind, override: PromptTemplateOverride | undefined, draft: PromptDraft): PromptEditorState {
  const start = initialPromptDraft(kind, override);
  const validation = validatePromptTemplate(kind, draft.template);
  const dirty = draft.template !== start.template || draft.basedOnHash !== start.basedOnHash;
  return {
    validation,
    used: new Set(promptTemplateVariables(draft.template)),
    dirty,
    isDefaultText: draft.template === DEFAULT_PROMPT_TEMPLATES[kind],
    staleDefault: override ? draft.basedOnHash !== defaultPromptTemplateHash(kind) : false,
    canSave: dirty && validation.ok,
    saveLabel: override ? 'Save changes' : 'Save as workspace prompt',
    chars: `${draft.template.length.toLocaleString()} chars`,
  };
}

export function promptOverride(draft: PromptDraft, now = new Date()): PromptTemplateOverride {
  return { template: draft.template, basedOnHash: draft.basedOnHash, updatedAt: now.toISOString() };
}

/** The PATCH body: an override saves, null resets the kind to Talyn's default. */
export function promptSettingsPatch(kind: PromptKind, override: PromptTemplateOverride | null): { settings: WorkspaceSettings } {
  return { settings: { prompts: { [kind]: override } } as WorkspaceSettings };
}

export function promptSavedMessage(kind: PromptKind, saved: boolean): string {
  const label = PROMPT_KIND_INFO[kind].label;
  return saved ? `${label} prompt saved` : `${label} prompt reset to Talyn's default`;
}

export const VARIABLE_GROUP_LABEL: Record<PromptVariableGroup, string> = {
  pr: 'Pull request',
  skill: 'Skill',
  review: 'Review findings',
  talyn: 'Talyn blocks',
};

/** The variables a kind may use, grouped in a fixed order. Empty groups are left out. */
export function variableGroups(kind: PromptKind): Array<{ group: PromptVariableGroup; label: string; items: PromptVariableSpec[] }> {
  const variables = promptVariablesFor(kind);
  return (['pr', 'skill', 'review', 'talyn'] as PromptVariableGroup[])
    .map((group) => ({ group, label: VARIABLE_GROUP_LABEL[group], items: variables.filter((v) => v.group === group) }))
    .filter((entry) => entry.items.length > 0);
}

export interface InsertResult { text: string; caret: number }

/** Block variables land on their own line; inline ones go exactly where the caret is. Same as web. */
export function insertVariableAt(text: string, start: number, end: number, spec: Pick<PromptVariableSpec, 'name' | 'shape'>): InsertResult {
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  const token = `{{${spec.name}}}`;
  const before = text.slice(0, from);
  const after = text.slice(to);
  let insert = token;
  if (spec.shape === 'block') {
    const needsLeading = before.length > 0 && !before.endsWith('\n');
    const needsTrailing = after.length > 0 && !after.startsWith('\n');
    insert = `${needsLeading ? '\n' : ''}${token}${needsTrailing ? '\n' : ''}`;
  }
  return { text: before + insert + after, caret: before.length + insert.length };
}

// Every provider whose publishing dialect differs, so the preview shows what a run on it is told.
export const PREVIEW_PROVIDERS: ReadonlyArray<{ value: CloudProviderType; label: string }> = [
  { value: 'selfhosted', label: 'Talyn Fleet' },
  { value: 'posthog_code', label: 'PostHog Code' },
];

export const SAMPLE_PR = {
  owner: 'acme',
  repo: 'widgets',
  number: 128,
  summary: {
    url: 'https://github.com/acme/widgets/pull/128',
    title: 'Add retry to the webhook client',
    headBranch: 'feat/webhook-retry',
    baseBranch: 'main',
    mergeable: 'CONFLICTING',
    reviewDecision: 'CHANGES_REQUESTED',
    blockingReason: 'merge_conflicts',
    checks: { total: 6, failed: 1 },
    unresolvedReviewThreads: 3,
  } as PRMergeableSummary,
};

const SAMPLE_SKILL = {
  name: 'pr-review',
  description: 'Review the PR for correctness and style.',
  content: '---\nname: pr-review\ndescription: Review the PR for correctness and style.\n---\n\nRead the diff, check the tests, and leave one review with findings ordered by severity.',
  source: 'platform' as const,
};

export type PreviewRow = Pick<PRRow, 'owner' | 'repo' | 'number' | 'summary'>;

/** The template rendered against a PR, like web's Preview tab. */
export function renderPromptPreview(kind: PromptKind, template: string, provider: CloudProviderType, row?: PreviewRow): string {
  const { owner, repo, number, summary } = row ?? SAMPLE_PR;
  if (kind === 'mergeable') return buildMergeablePrompt({ owner, repo, number, summary: summary as PRMergeableSummary, provider, template });
  return buildSkillPrompt({ owner, repo, number, provider, template, skill: SAMPLE_SKILL,
    pr: { url: summary.url, title: summary.title ?? '', headBranch: summary.headBranch, baseBranch: summary.baseBranch } });
}

export function previewNote(kind: PromptKind): string {
  return kind === 'skill' ? 'Rendered with a sample skill so you can see where the SKILL.md lands.'
    : 'Rendered against the selected PR as it looks right now.';
}

export function previewRowLabel(row: PreviewRow | undefined): string {
  return row ? `${row.owner}/${row.repo}#${row.number} · ${row.summary.title}` : 'Sample PR (no tracked PRs yet)';
}
