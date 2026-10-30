/**
 * Plan mode in a session chat.
 *
 * `claude -p` has no ExitPlanMode tool, and Codex never had one, so the agent
 * cannot ask for approval itself. A plan-mode turn is told to end its reply
 * with the plan in a ```talyn-plan block. The transcript draws that block as a
 * card with "Approve and build" and "Keep planning".
 */
import type { AgentEvent } from './index.js';
import type { WorkbenchAgent, WorkbenchMessageIntent } from './workbench.js';
import { buildAutoCreatePrInstructions, buildCreatePrTurnInstructions } from './workbenchPullRequest.js';
import { importedPathsNote } from './claudeSessionImport.js';
import { SANDBOX_SERVICES_NOTE } from './sandboxSize.js';

export const PLAN_BLOCK_FENCE = 'talyn-plan';

/** The visible message "Approve and build" sends. */
export const PLAN_APPROVED_MESSAGE = 'Approved. Build the plan.';

export function buildPlanTurnInstructions(): string {
  return [
    'You are in plan mode in Talyn. You cannot change files in this turn.',
    'The ExitPlanMode tool is not available. Talyn shows your plan to the person with buttons to approve it or to keep planning.',
    '',
    '1. Read the code you need, then make the plan.',
    '2. If you must have an answer from the person before you can plan, ask the question and stop. Do not write a plan block.',
    `3. When the plan is ready, end the reply with the complete plan in one fenced block that opens with \`\`\`${PLAN_BLOCK_FENCE}.`,
    '   Write the plan in Markdown inside the block, and write nothing after it.',
    `   If the plan contains \`\`\` code blocks, open the block with \`\`\`\`${PLAN_BLOCK_FENCE} and close it with \`\`\`\`.`,
    '4. Do not ask for approval in words, and do not write the plan to a file. The buttons do that.',
  ].join('\n');
}

/** Told to every turn of a session whose box has Talyn's own MCP server. */
export const TALYN_TOOLS_NOTE =
  "Talyn's own tools are available through the `talyn` MCP server, as the person who owns this session: " +
  'for example to archive this session, start another session, or use the merge queue. ' +
  'If you archive this session, Talyn does it after your reply ends.';

/**
 * The built-in skills Talyn writes into a session box before each turn, for
 * Claude in `~/.claude/skills/<name>/` and for Codex in `~/.codex/skills/<name>/`.
 * The files live in the backend (`services/workbenches/skillPack/<name>/SKILL.md`);
 * this list is what both the delivery and the turn prompt name.
 */
export const TALYN_SKILL_PACK = [
  'talyn-multi-repo',
  'talyn-delegate',
  'talyn-ci-triage',
  'talyn-ship-pr',
  'talyn-review-loop',
  'talyn-wrap-up',
] as const;

export type TalynSkillName = (typeof TALYN_SKILL_PACK)[number];

/** Added to {@link TALYN_TOOLS_NOTE} when the box has the skill pack. */
export const TALYN_SKILLS_NOTE =
  'Talyn installed the skills `talyn-multi-repo`, `talyn-delegate`, `talyn-ci-triage`, `talyn-ship-pr`, ' +
  '`talyn-review-loop` and `talyn-wrap-up`: use them for other repositories, child sessions, failing CI, ' +
  'the pull request, review feedback and ending the session.';

/**
 * The prompt for one turn, with the hidden instructions it needs. Claude takes
 * them as an appended system prompt, and on a Create PR turn also in front of
 * the prompt. Codex has no such flag, so they go in front of the prompt. The
 * stored, visible message is `text` either way: the runtimes store the user
 * message from `text`, never from the prompt this returns.
 */
export function workbenchTurnPrompt(input: {
  agent: WorkbenchAgent;
  text: string;
  planMode: boolean;
  intent?: WorkbenchMessageIntent;
  createPr: { branch: string; baseBranch: string; extra?: string | null };
  internetAccess?: boolean;
  autoCreatePr?: boolean;
  hasPullRequest?: boolean;
  /** A chat that continues a local conversation: where it came from and the box's repo folder. */
  imported?: { root: string; repoDir: string } | null;
  recap?: string;
  /** The box has Talyn's own MCP server, named `talyn`. */
  talynTools?: boolean;
  /** The box has Talyn's skill pack. Named only together with `talynTools`. */
  talynSkills?: boolean;
}): { prompt: string; appendSystemPrompt?: string } {
  const actionInstructions =
    input.intent === 'create_pr'
      ? buildCreatePrTurnInstructions(input.createPr)
      : input.planMode
        ? buildPlanTurnInstructions()
        : null;
  const networkNote = input.internetAccess === false
    ? 'This sandbox reaches only its repository, the package registries (npm, PyPI, apt), and the agent API.'
    : null;
  const autoPrNote = input.autoCreatePr !== false && !input.hasPullRequest && input.intent !== 'create_pr'
    ? buildAutoCreatePrInstructions()
    : null;
  const importNote = input.imported ? importedPathsNote(input.imported, input.imported.repoDir) : null;
  const talynNote = input.talynTools
    ? input.talynSkills
      ? `${TALYN_TOOLS_NOTE} ${TALYN_SKILLS_NOTE}`
      : TALYN_TOOLS_NOTE
    : null;
  const instructions = [actionInstructions, networkNote, autoPrNote, importNote, talynNote, SANDBOX_SERVICES_NOTE, input.recap]
    .filter(Boolean)
    .join('\n\n');
  if (!instructions) return { prompt: input.text };
  if (input.agent === 'codex') return { prompt: `${instructions}\n\n---\n\n${input.text}` };
  // A Create PR turn also puts its instructions in Claude's prompt. In a system
  // prompt alone they lost to the repository's own pull-request process: the
  // agent made a new branch, published it and opened the PR itself.
  if (input.intent === 'create_pr') {
    return { prompt: `${instructions}\n\n---\n\n${input.text}`, appendSystemPrompt: instructions };
  }
  return { prompt: input.text, appendSystemPrompt: instructions };
}

// ============================================================================
// Reading the plan back
// ============================================================================

const OPENER = new RegExp(`^(\`{3,}|~{3,})[ \\t]*${PLAN_BLOCK_FENCE}[ \\t]*$`);

interface PlanSpan {
  /** Line index of the opening fence. */
  start: number;
  /** Line index just past the closing fence, or the line count when it never closes. */
  end: number;
  body: string;
}

function planSpans(text: string): { lines: string[]; spans: PlanSpan[] } {
  const lines = text.split('\n');
  const spans: PlanSpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = OPENER.exec(lines[i].trimEnd());
    if (!open) continue;
    const fence = open[1];
    let close = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (line.length >= fence.length && line[0] === fence[0] && /^(`+|~+)$/.test(line)) {
        close = j;
        break;
      }
    }
    spans.push({ start: i, end: Math.min(close + 1, lines.length), body: lines.slice(i + 1, close).join('\n').trim() });
    i = close;
  }
  return { lines, spans };
}

/** The last plan block in one piece of text, or null. An unclosed block runs to the end. */
export function parsePlanBlock(text: string): string | null {
  const { spans } = planSpans(text);
  for (let k = spans.length - 1; k >= 0; k--) if (spans[k].body) return spans[k].body;
  return null;
}

/** The text with every plan block taken out; the card shows the plan instead. */
export function stripPlanBlocks(text: string): string {
  if (!text.includes(PLAN_BLOCK_FENCE)) return text;
  const { lines, spans } = planSpans(text);
  if (spans.length === 0) return text;
  const kept: string[] = [];
  let at = 0;
  for (const span of spans) {
    kept.push(...lines.slice(at, span.start));
    at = span.end;
  }
  kept.push(...lines.slice(at));
  return kept.join('\n').trim();
}

/** Claude's own plan file, which it writes in plan mode when it ignores the block instruction. */
const PLAN_FILE = /\/\.claude\/plans\/[^/]+\.md$/;

type ContentPart = { type?: string; text?: unknown; name?: unknown; input?: unknown };

function contentOf(event: AgentEvent): ContentPart[] {
  const message = (event as { message?: { content?: unknown } }).message;
  return event.type === 'assistant' && Array.isArray(message?.content) ? (message.content as ContentPart[]) : [];
}

/**
 * The plan one turn produced: the last ```talyn-plan block in the agent's
 * text, else the last plan file it wrote. Null when the turn made no plan, for
 * example when it asked a question instead.
 */
export function findTurnPlan(events: readonly AgentEvent[]): string | null {
  let fromFile: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    for (const part of [...contentOf(events[i])].reverse()) {
      if (part.type === 'text' && typeof part.text === 'string') {
        const plan = parsePlanBlock(part.text);
        if (plan) return plan;
      }
      if (fromFile === null && part.type === 'tool_use' && part.name === 'Write') {
        const input = part.input as { file_path?: unknown; content?: unknown } | undefined;
        if (typeof input?.file_path === 'string' && PLAN_FILE.test(input.file_path) && typeof input.content === 'string') {
          fromFile = input.content.trim() || null;
        }
      }
    }
  }
  return fromFile;
}
