/**
 * Create PR for a workbench, through the chat.
 *
 * Create PR sends a short visible message ({@link CREATE_PR_MESSAGE}) to the
 * chat with the `create_pr` intent. The agent also gets Talyn's instructions
 * ({@link buildCreatePrTurnInstructions}), which the transcript never shows:
 * Claude through `--append-system-prompt`, Codex in front of the prompt. The
 * agent only writes the words, in a ```talyn-pr block at the end of its reply.
 * When the turn ends, Talyn commits what is uncommitted, pushes the branch and
 * opens the pull request through the GitHub API, and records the outcome in
 * the thread ({@link pullRequestOutcomeEvent}).
 *
 * Pure, like the rest of the workbench vocabulary: the backend (sandbox) and
 * the desktop (local) build the same instructions and steps from here, and
 * parse the same answer.
 */
import type { GitStep } from './workbenchGit.js';
import type { Workbench } from './workbench.js';

// ============================================================================
// Shapes
// ============================================================================

/** What the agent answers with. `commitMessage` is '' when nothing is uncommitted. */
export interface WorkbenchPrDetails {
  title: string;
  body: string;
  commitMessage: string;
  draft: boolean;
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

/** The visible message a Create PR press sends. */
export const CREATE_PR_MESSAGE = 'Create a pull request';

/** The fence language of the agent's answer. */
export const PR_BLOCK_FENCE = 'talyn-pr';

export const MISSING_PR_BLOCK_MESSAGE = 'The agent did not return a pull request title. Press Create PR to try again.';

// ============================================================================
// The hidden instructions
// ============================================================================

const TEMPLATE_PATHS = [
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/PULL_REQUEST_TEMPLATE/ (any file in it)',
  'PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
];

/**
 * What the agent is told on a Create PR turn. It must not commit, push or open
 * the PR: Talyn does that from the block at the end of the reply. `extra` is
 * the workbench's `settings.prompts.create_pr`, appended as it stands.
 */
export function buildCreatePrTurnInstructions(input: {
  branch: string;
  baseBranch: string;
  extra?: string | null;
}): string {
  const base = input.baseBranch;
  const lines = [
    `The person pressed Create PR in Talyn. Prepare the pull request for the work on this branch (\`${input.branch}\`), to be merged into \`${base}\`.`,
    '',
    'Do not commit, push or open the pull request, and do not run `gh`. Talyn commits any uncommitted changes,',
    'pushes the branch and opens the pull request from your reply when this turn ends.',
    '',
    '1. See everything that changed:',
    '   - `git status` for uncommitted changes, and `git diff HEAD` for their content.',
    `   - \`git log origin/${base}..HEAD\` and \`git diff origin/${base}...HEAD\` for the commits on this branch`,
    `     (use \`${base}\` instead of \`origin/${base}\` when there is no remote branch).`,
    '2. Look for a pull request template. Check these paths, in any letter case:',
    ...TEMPLATE_PATHS.map((p) => `   - \`${p}\``),
    '3. Reply with a short summary for the person: two or three sentences on what the pull request contains.',
    `4. End the reply with one \`\`\`${PR_BLOCK_FENCE} fenced block that holds one JSON object, and write nothing after it:`,
    '',
    `\`\`\`${PR_BLOCK_FENCE}`,
    '{"title": "...", "body": "...", "commitMessage": "...", "draft": false}',
    '```',
    '',
    '   - "title": a conventional-commit summary of the change (`feat: …`, `fix: …`, `chore: …`), under 72 characters.',
    '   - "body": the description, in Markdown, as a JSON string. If there is a template, fill it in and keep its headings.',
    '     Otherwise say what changed and why, how it was tested, and anything a reviewer must know.',
    '   - "commitMessage": a conventional commit message for the uncommitted changes, or "" when there are none.',
    '   - "draft": true only when the person asked for a draft pull request.',
  ];
  const extra = input.extra?.trim();
  if (extra) lines.push('', 'Extra instructions for this pull request:', '', extra);
  return lines.join('\n');
}

// ============================================================================
// Parsing the answer
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

/**
 * The JSON object that opens each fence of `lang`, in order. The object is
 * read string-aware rather than up to the closing fence, because a body may
 * quote a code block of its own.
 */
function fencedObjects(text: string, lang: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of text.matchAll(new RegExp(`\`\`\`${lang}[^\\S\\n]*\\n`, 'g'))) {
    let i = (m.index ?? 0) + m[0].length;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '{') continue;
    const end = objectEnd(text, i);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(i, end));
      if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value as Record<string, unknown>);
    } catch {
      // Not JSON; the next fence may be.
    }
  }
  return out;
}

function detailsFrom(value: Record<string, unknown>): WorkbenchPrDetails | null {
  if (typeof value.title !== 'string') return null;
  const title = value.title.replace(/\s+/g, ' ').trim().slice(0, PR_TITLE_MAX);
  if (!title) return null;
  return {
    title,
    body: typeof value.body === 'string' ? value.body.trim() : '',
    commitMessage: typeof value.commitMessage === 'string' ? value.commitMessage.trim() : '',
    draft: value.draft === true,
  };
}

/**
 * The pull request in the agent's final message: the last ```talyn-pr block
 * with a title, else the last ```json block with one. An object without a
 * title is not an answer.
 */
export function parsePrDetails(text: string): { ok: true; details: WorkbenchPrDetails } | { ok: false; error: string } {
  for (const lang of [PR_BLOCK_FENCE, 'json']) {
    const found = fencedObjects(text ?? '', lang)
      .map(detailsFrom)
      .filter((d): d is WorkbenchPrDetails => d !== null);
    if (found.length > 0) return { ok: true, details: found[found.length - 1] };
  }
  return { ok: false, error: MISSING_PR_BLOCK_MESSAGE };
}

// ============================================================================
// The outcome in the thread
// ============================================================================

export type PullRequestOutcome =
  | { ok: true; number: number; url: string; existing: boolean }
  | { ok: false; message: string };

/** The transcript event that records what a Create PR turn did. `buildBlocks` renders it as one line. */
export function pullRequestOutcomeEvent(outcome: PullRequestOutcome): Record<string, unknown> {
  return { type: 'talyn_pr', ...outcome };
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

/** The commit message for uncommitted changes: the agent's, else the title. */
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
