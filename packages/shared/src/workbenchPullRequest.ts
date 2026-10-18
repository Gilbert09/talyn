/**
 * Create PR for a workbench, without the chat.
 *
 * Talyn does the git and GitHub work itself: it commits what is uncommitted,
 * pushes the branch and opens the pull request through the GitHub API. An
 * agent only DRAFTS the words, in a one-shot hidden run that forks the chat's
 * session so it knows what was done. Nothing is posted into the transcript.
 *
 * Pure, like the rest of the workbench vocabulary: the backend (sandbox) and
 * the Electron main process (local) both build the same argv, steps and
 * prompt from here, and parse the same answer.
 */
import { DEFAULT_FLEET_CODEX_MODEL_ID, DEFAULT_FLEET_MODEL_ID } from './index.js';
import { buildClaudeArgv, buildCodexArgv } from './agentStream.js';
import type { GitStep } from './workbenchGit.js';
import type { Workbench, WorkbenchAgent } from './workbench.js';

// ============================================================================
// Shapes
// ============================================================================

/** What the draft run answers with. Every field is plain text; `commitMessage` is '' when nothing is uncommitted. */
export interface WorkbenchPrDraft {
  title: string;
  body: string;
  commitMessage: string;
}

export interface DraftWorkbenchPullRequestInput {
  /** The chat whose agent session the draft forks. Default: the latest chat. */
  chatId?: string;
  /** Default: the workbench's base branch. */
  base?: string;
}

export interface CreateWorkbenchPullRequestInput {
  title: string;
  body: string;
  base: string;
  draft?: boolean;
  /** Used when there are uncommitted changes. Blank falls back to the title. */
  commitMessage?: string;
  /**
   * Local runtime only: the desktop already committed and pushed with the
   * user's own git credentials, so the backend only opens the PR.
   */
  pushed?: boolean;
}

export interface CreateWorkbenchPullRequestResult {
  workbench: Workbench;
  pullRequest: { number: number; url: string };
  /** True when a PR from this branch already existed and was linked instead. */
  existing: boolean;
}

/** GitHub refuses a longer title. */
export const PR_TITLE_MAX = 256;

/** The draft run's bound. It reads a diff and writes a paragraph; three minutes is generous. */
export const PR_DRAFT_TIMEOUT_MS = 180_000;

// ============================================================================
// The draft prompt and argv
// ============================================================================

const TEMPLATE_PATHS = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  'PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE/ (any file in it)',
];

/**
 * The prompt for the draft run. It must only read: Talyn commits, pushes and
 * opens the PR after a person has checked the words. `extraInstructions` is
 * the workbench's own `settings.prompts.create_pr`, appended as it stands.
 */
export function buildPrDraftPrompt(input: {
  branch: string;
  baseBranch: string;
  extraInstructions?: string | null;
}): string {
  const base = input.baseBranch;
  const lines = [
    `Write the pull request for the work on this branch (\`${input.branch}\`), to be merged into \`${base}\`.`,
    '',
    'Only read. Do not edit files, commit, push or open the pull request: Talyn does that after a person checks your draft.',
    '',
    '1. See everything that changed:',
    '   - `git status` for uncommitted changes, and `git diff HEAD` for their content.',
    `   - \`git log origin/${base}..HEAD\` and \`git diff origin/${base}...HEAD\` for the commits on this branch`,
    `     (use \`${base}\` instead of \`origin/${base}\` when there is no remote branch).`,
    '2. Look for a pull request template. Check these paths, in any letter case:',
    ...TEMPLATE_PATHS.map((p) => `   - \`${p}\``),
    '3. Reply with ONLY one JSON object, in a ```json fenced block, with these keys:',
    '   - "title": a conventional-commit summary of the change (`feat: …`, `fix: …`, `chore: …`), under 72 characters.',
    '   - "body": the description, in Markdown. If there is a template, fill it in and keep its headings.',
    '     Otherwise say what changed and why, how it was tested, and anything a reviewer must know.',
    '   - "commitMessage": a conventional commit message for the uncommitted changes, or "" when there are none.',
  ];
  const extra = input.extraInstructions?.trim();
  if (extra) lines.push('', 'Extra instructions for this pull request:', '', extra);
  return lines.join('\n');
}

/**
 * Claude's tools for the draft run: reads only. With `--permission-mode
 * dontAsk`, anything not on this list is denied without a prompt, which is
 * what a headless run needs. Claude Code matches `Bash(git diff:*)` per
 * command, so `git diff && rm x` does not match.
 */
export const PR_DRAFT_CLAUDE_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git branch:*)',
  'Bash(git rev-parse:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
];

/**
 * The draft run's argv.
 *
 * Claude: `claude -p … --model <Sonnet> --permission-mode dontAsk --resume
 * <session> --fork-session --allowedTools …`. The fork is what keeps the
 * chat's own session untouched: the draft gets a new session id, and nothing
 * stores it. With no session yet, it runs fresh.
 *
 * Codex: `codex exec --json … -c sandbox_mode="read-only"`, fresh. Codex has
 * no fork, and `exec resume` would continue the chat's own session.
 */
export function buildPrDraftArgv(input: {
  agent: WorkbenchAgent;
  prompt: string;
  resumeSessionId?: string | null;
  /** Codex only: the chat's model, which is known to work for this subscription. */
  model?: string | null;
}): string[] {
  if (input.agent === 'codex') {
    return buildCodexArgv({
      prompt: input.prompt,
      model: input.model || DEFAULT_FLEET_CODEX_MODEL_ID,
      sandboxMode: 'read-only',
    });
  }
  return buildClaudeArgv({
    prompt: input.prompt,
    model: DEFAULT_FLEET_MODEL_ID,
    permissionMode: 'dontAsk',
    ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId, forkSession: true } : {}),
    allowedTools: [...PR_DRAFT_CLAUDE_TOOLS],
  });
}

// ============================================================================
// Parsing the draft
// ============================================================================

/** The index just past the `{…}` that opens at `start`, string-aware; -1 when it never closes. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/** Every top-level JSON object in `text` that parses, in order. */
function jsonObjects(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    const end = objectEnd(text, i);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(i, end));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        out.push(value as Record<string, unknown>);
        i = end - 1;
      }
    } catch {
      // Not JSON from here; try the next brace.
    }
  }
  return out;
}

function draftFrom(value: Record<string, unknown>): WorkbenchPrDraft | null {
  if (typeof value.title !== 'string') return null;
  const title = value.title.replace(/\s+/g, ' ').trim().slice(0, PR_TITLE_MAX);
  if (!title) return null;
  return {
    title,
    body: typeof value.body === 'string' ? value.body.trim() : '',
    commitMessage: typeof value.commitMessage === 'string' ? value.commitMessage.trim() : '',
  };
}

/**
 * The draft in the agent's final message. The last ```json fenced block wins;
 * without one, the last JSON object in the text. An object without a title is
 * not a draft.
 */
export function parsePrDraft(text: string): { ok: true; draft: WorkbenchPrDraft } | { ok: false; error: string } {
  const fences = [...(text ?? '').matchAll(/```(?:json)?[^\S\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const block of fences.reverse()) {
    const drafts = jsonObjects(block).map(draftFrom).filter((d): d is WorkbenchPrDraft => d !== null);
    if (drafts.length > 0) return { ok: true, draft: drafts[drafts.length - 1] };
  }
  const drafts = jsonObjects(text ?? '').map(draftFrom).filter((d): d is WorkbenchPrDraft => d !== null);
  if (drafts.length > 0) return { ok: true, draft: drafts[drafts.length - 1] };
  return { ok: false, error: 'The agent did not answer with a title and description.' };
}

// ============================================================================
// Commit and push
// ============================================================================

/** stdout is empty when the working tree is clean (untracked files count as changes). */
export function workingTreeStatus(): GitStep {
  return { argv: ['git', 'status', '--porcelain'] };
}

/**
 * Stage everything and commit it. The message is one argv element: the local
 * runtime runs it with `execFile` (no shell), and the sandbox's script quotes
 * it with `shellQuote`, so no message can run as a command.
 */
export function commitAllSteps(message: string): GitStep[] {
  return [
    { argv: ['git', 'add', '-A'] },
    { argv: ['git', 'commit', '-m', message] },
  ];
}

/**
 * How many commits HEAD has that `origin/<base>` does not. Both steps may
 * fail (no remote branch, no network); {@link parseCommitsAhead} then answers
 * null and the check is left to GitHub.
 */
export function commitsAheadSteps(base: string): GitStep[] {
  return [
    { argv: ['git', 'fetch', 'origin', base], allowFailure: true, env: { GIT_TERMINAL_PROMPT: '0' } },
    { argv: ['git', 'rev-list', '--count', `refs/remotes/origin/${base}..HEAD`], allowFailure: true },
  ];
}

export function parseCommitsAhead(stdout: string): number | null {
  const last = stdout.trim().split('\n').pop()?.trim() ?? '';
  return /^\d+$/.test(last) ? Number(last) : null;
}

/** Push the current branch and track it. Never prompts: a missing credential fails at once. */
export function pushHeadStep(): GitStep {
  return { argv: ['git', 'push', '-u', 'origin', 'HEAD'], env: { GIT_TERMINAL_PROMPT: '0' } };
}

/** The commit message for uncommitted changes: the draft's, else the title. */
export function prCommitMessage(input: Pick<CreateWorkbenchPullRequestInput, 'title' | 'commitMessage'>): string {
  return input.commitMessage?.trim() || input.title.trim();
}

export function nothingToOpenMessage(base: string): string {
  return `There is nothing to open a pull request for: the branch has no commits ahead of ${base}.`;
}

/** The last few lines of git's stderr, for the detail of an error. */
export function gitStderrTail(stderr: string, lines = 4): string {
  return stderr
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-lines)
    .join('\n');
}

/**
 * A failed `git push`, in words a person can act on. In a sandbox the push
 * goes through the fleet proxy with the workspace's GitHub App token, so a
 * refusal there means the App lacks write access. On the user's machine it is
 * their own credentials.
 */
export function describePushFailure(input: { stderr: string; runtime: 'sandbox' | 'local'; repoFullName: string }): string {
  const detail = gitStderrTail(input.stderr);
  const refused = /\b403\b|permission to .* denied|write access to repository not granted|access denied|denied to/i.test(
    input.stderr,
  );
  let head: string;
  if (refused && input.runtime === 'sandbox') {
    head = `GitHub refused the push. The Talyn GitHub App needs Contents: Read & write on ${input.repoFullName}.`;
  } else if (refused) {
    head = `GitHub refused the push. Check that your git credentials can write to ${input.repoFullName}.`;
  } else if (/\[rejected\]|non-fast-forward|fetch first/i.test(input.stderr)) {
    head = 'GitHub rejected the push: the remote branch has commits this branch does not have. Pull or merge them first.';
  } else {
    head = 'Could not push the branch.';
  }
  return detail ? `${head}\n${detail}` : head;
}
