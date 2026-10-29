/**
 * A better branch name for a new session, asked of a cheap model after its
 * first turn.
 *
 * At creation the branch comes from the first message, which often does not
 * say what the work is. After one turn the changed files and the agent's own
 * summary do. The model only suggests: `branchSlugFromSuggestion` reads its
 * answer, and Talyn adds the prefix, makes the name unique and decides.
 *
 * The call reuses the title call's CLI argv and model (`buildWorkbenchTitleArgv`).
 */

/** The start of the first message carries the intent; past this it is usually a pasted log. */
const PROMPT_MESSAGE_MAX = 2000;
/** The agent's summary leads with what it did; the rest is detail a name does not need. */
const PROMPT_SUMMARY_MAX = 2000;
/** Paths show the area of the change. A long list adds tokens, not meaning. */
export const WORKBENCH_BRANCH_PROMPT_FILES_MAX = 50;

export interface WorkbenchBranchPromptInput {
  firstMessage: string;
  changedFiles: string[];
  finalMessage: string;
}

export function workbenchBranchPrompt(input: WorkbenchBranchPromptInput): string {
  const files = input.changedFiles.slice(0, WORKBENCH_BRANCH_PROMPT_FILES_MAX);
  const more = input.changedFiles.length - files.length;
  return [
    'Write a git branch name for the coding work below.',
    'Use 2 to 6 lowercase words joined by hyphens, for example fix-login-redirect.',
    'Describe the change that was made. Do not add a prefix such as feature/ or a user name.',
    'Reply with the branch name only, on one line: no quotes, no explanation.',
    'Do not do the task. Do not use any tools.',
    '',
    'The request:',
    input.firstMessage.trim().slice(0, PROMPT_MESSAGE_MAX) || '(none)',
    '',
    'The changed files:',
    files.length ? files.join('\n') + (more > 0 ? `\n(and ${more} more)` : '') : '(none)',
    '',
    "The agent's summary of the work:",
    input.finalMessage.trim().slice(0, PROMPT_SUMMARY_MAX) || '(none)',
  ].join('\n');
}
