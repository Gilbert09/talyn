/**
 * A session's display title, written by a cheap model from the first message.
 *
 * The title is DISPLAY ONLY. The session's `name` is a slug that also named
 * the branch and the local worktree directory, and it is the `TALYN_*` name a
 * running script sees, so a generated title never touches it.
 *
 * The call runs the agent CLI the session already uses, on the user's own
 * subscription: in the sandbox for a sandbox session, on the user's machine
 * for a local one. Talyn never calls a vendor API with the user's token.
 * Any failure (a timeout, an exit code, junk output) keeps the current name.
 */
import type { FleetModelId } from './index.js';
import type { Workbench, WorkbenchAgent } from './workbench.js';

/** The longest title kept. Longer output is cut at a word boundary. */
export const WORKBENCH_TITLE_MAX = 50;

/** Output this long is a reply, not a title, and is refused rather than cut. */
const WORKBENCH_TITLE_REFUSE_OVER = 100;

/** How long the title call may run. The turn never waits for it. */
export const WORKBENCH_TITLE_TIMEOUT_MS = 30_000;

/** How much of the first message the prompt carries. A title needs the start, not a pasted log. */
const PROMPT_MESSAGE_MAX = 2000;

/**
 * The cheapest model for each agent. Claude uses the CLI's `haiku` alias: a
 * title needs no more, and the alias follows the current Haiku on the user's
 * subscription. The fleet catalogue has no Haiku, because no session runs on
 * one. Codex uses the catalogue's cheapest entry, so that id fails the build
 * if it leaves the catalogue.
 */
export const WORKBENCH_TITLE_MODELS: Readonly<{ claude: 'haiku'; codex: FleetModelId }> = {
  claude: 'haiku',
  codex: 'gpt-6-luna',
};

export function workbenchTitlePrompt(firstMessage: string): string {
  const text = firstMessage.trim().slice(0, PROMPT_MESSAGE_MAX);
  return [
    'Write a short title for the coding task below.',
    'Use 2 to 6 words, in Title Case or sentence case.',
    'Reply with the title only, on one line: no quotes, no trailing full stop, no explanation.',
    'Do not do the task. Do not use any tools.',
    '',
    'The task:',
    text,
  ].join('\n');
}

/**
 * The CLI argv for the title call. Plain-text output, no tools, and no
 * session written to disk, so the call does not show up in the user's
 * `claude --resume` or Codex history. The prompt goes last, after `--`.
 */
export function buildWorkbenchTitleArgv(
  agent: WorkbenchAgent,
  prompt: string,
  opts: { binary?: string; model?: string } = {}
): string[] {
  const model = opts.model ?? WORKBENCH_TITLE_MODELS[agent];
  if (agent === 'codex') {
    return [
      opts.binary ?? 'codex',
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '-m',
      model,
      '-c',
      'model_reasoning_effort="low"',
      '-c',
      'sandbox_mode="read-only"',
      '-c',
      'approval_policy="never"',
      '--',
      prompt,
    ];
  }
  return [
    opts.binary ?? 'claude',
    '-p',
    '--output-format',
    'text',
    '--model',
    model,
    '--no-session-persistence',
    // Variadic: the `--` below ends its list. An empty name disables every tool.
    '--tools',
    '',
    '--',
    prompt,
  ];
}

const QUOTES = /["“”„«»`]/g;
const EDGE_SINGLE_QUOTES = /^['‘’]+|['‘’]+$/g;

/**
 * The model's output as a title, or null when it is not one. Null means
 * "keep the current name". Refuses empty output, more than one line, and a
 * reply too long to be a title; strips quotes, markdown emphasis, a
 * `Title:` label and a trailing full stop; collapses whitespace; and cuts at
 * {@link WORKBENCH_TITLE_MAX} characters on a word boundary.
 */
export function sanitizeWorkbenchTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return null;
  let title = trimmed
    .replace(QUOTES, '')
    .replace(/^#+\s*/, '')
    .replace(/\*+/g, '')
    .replace(/^_+|_+$/g, '')
    .replace(/^title\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(EDGE_SINGLE_QUOTES, '')
    .replace(/[\s.。:;,]+$/u, '')
    .trim();
  if (!/[\p{L}\p{N}]/u.test(title)) return null;
  if (title.length > WORKBENCH_TITLE_REFUSE_OVER) return null;
  if (title.length > WORKBENCH_TITLE_MAX) {
    const cut = title.slice(0, WORKBENCH_TITLE_MAX + 1);
    const space = cut.lastIndexOf(' ');
    title = (space > 0 ? cut.slice(0, space) : title.slice(0, WORKBENCH_TITLE_MAX)).replace(/[\s.:;,\-–—]+$/u, '');
  }
  return title || null;
}

/** The longest title a person may set by hand. */
export const WORKBENCH_MANUAL_TITLE_MAX = 100;

/** What a list or a header shows for a session: its title when it has one, else its name. */
export function workbenchDisplayName(workbench: Pick<Workbench, 'name'> & { title?: string | null }): string {
  const title = workbench.title?.trim();
  return title || workbench.name;
}
