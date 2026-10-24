import {
  createClaudeStreamParser,
  nextWorkbenchAction,
  prSummaryToNextActionPr,
  type AgentEvent,
  type AgentEventDraft,
  type Workbench,
  type WorkbenchAttachment,
  type WorkbenchContextUsage,
  type WorkbenchEvent,
  type WorkbenchNextAction,
  type WorkbenchNextActionInput,
  type WorkbenchTodo,
} from '@talyn/shared';
import type { PRRow, PRState, PRSummaryShape } from './api';
import { knownContextWindow, rememberContextWindow } from './contextWindows';
import { isInjectedUserMessage } from './skillInstructions';

/**
 * Helpers for the Workbenches panel. Chat insights stores reported context
 * windows in localStorage.
 */

// ============================================================================
// User messages in the transcript
// ============================================================================

/**
 * The event that records what the user sent, at the head of each turn.
 *
 * Claude's stream does not echo the prompt in `-p` mode, so the runtime writes
 * it. The shape is a Claude `user` event with a `text` block: `buildBlocks`
 * renders only `tool_result` blocks from a user event, so the agent transcript
 * ignores it and the workbench transcript draws it as a message bubble.
 */
export function makeUserMessageEvent(text: string, attachments?: WorkbenchAttachment[]): AgentEventDraft {
  const draft: AgentEventDraft = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    talyn_user_message: true,
  };
  if (attachments?.length) {
    draft.talyn_attachments = attachments.map((a) => ({ name: a.name, mimeType: a.mimeType, path: a.path }));
  }
  return draft;
}

export function messageAttachments(event: AgentEvent): Array<{ name: string; mimeType: string; path?: string }> {
  const talyn = event.talyn as { attachments?: unknown } | undefined;
  const raw = talyn?.attachments ?? event.talyn_attachments;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const a = item as Record<string, unknown>;
    if (typeof a.name !== 'string' || typeof a.mimeType !== 'string') return [];
    return [{ name: a.name, mimeType: a.mimeType, ...(typeof a.path === 'string' ? { path: a.path } : {}) }];
  });
}

/**
 * The text of a user message event, or null for any other event.
 *
 * Accepts the shape above, a bare string `content`, and a
 * `talyn_user_message` event with a top-level `text` — whichever the runtime
 * that stored it chose. A user event that carries only `tool_result` blocks is
 * the agent's own tool output, not a message. Nor is text the harness injected,
 * such as a launched skill's SKILL.md: the Skill call draws that.
 */
export function userMessageText(event: AgentEvent): string | null {
  if (event.type === 'talyn_user_message' && typeof event.text === 'string') return event.text;
  if (event.type !== 'user' || isInjectedUserMessage(event)) return null;
  const content = event.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown };
    if (b?.type === 'tool_result') return null;
    if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
  }
  return texts.length ? texts.join('\n') : null;
}

export interface TranscriptTurn {
  turn: number;
  /** The user's message for this turn, when one was recorded. */
  userText: string | null;
  userSeq: number | null;
  attachments: ReturnType<typeof messageAttachments>;
  /** The agent's events for the turn, user message excluded. */
  events: AgentEvent[];
}

/** Split a chat's events into turns, each led by the user's message. */
export function splitTurns(events: WorkbenchEvent[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;
  for (const e of events) {
    const text = userMessageText(e.event);
    if (!current || current.turn !== e.turn || (text !== null && current.userText !== null)) {
      current = { turn: e.turn, userText: null, userSeq: null, attachments: [], events: [] };
      turns.push(current);
    }
    if (text !== null && current.userText === null && current.events.length === 0) {
      current.userText = text;
      current.userSeq = e.seq;
      current.attachments = messageAttachments(e.event);
    } else {
      current.events.push(e.event);
    }
  }
  return turns;
}

// ============================================================================
// Derived chat state: to-dos and context usage
// ============================================================================

export interface ChatInsights {
  todos: WorkbenchTodo[] | null;
  contextUsage: WorkbenchContextUsage | null;
  slashCommands: string[] | null;
}

/**
 * The agent's latest to-do list and how full its context is.
 *
 * Stored events are already in Claude's stream-json shape — Codex output is
 * converted on the way in — so Claude's parser reads both agents' history.
 * Only the events that decide the answer go through it: the last `TodoWrite`,
 * the last top-level assistant message (its usage is the prompt size), the
 * last result (the context window) and the last init (the model). A long chat
 * re-derives this on every new event, so it must not re-parse everything.
 */
export function chatInsights(events: WorkbenchEvent[]): ChatInsights {
  let todo = -1;
  let assistant = -1;
  let result = -1;
  let init = -1;
  for (let i = events.length - 1; i >= 0 && (todo < 0 || assistant < 0 || result < 0 || init < 0); i--) {
    const ev = events[i].event;
    if (ev.type === 'assistant') {
      if (assistant < 0 && !ev.parent_tool_use_id && ev.message?.usage) assistant = i;
      if (todo < 0 && Array.isArray(ev.message?.content)) {
        const hasTodo = (ev.message?.content as Array<{ type?: unknown; name?: unknown }>).some(
          (b) => b?.type === 'tool_use' && b.name === 'TodoWrite'
        );
        if (hasTodo) todo = i;
      }
    } else if (ev.type === 'result' && result < 0) result = i;
    else if (ev.type === 'system' && ev.subtype === 'init' && init < 0) init = i;
  }
  const parser = createClaudeStreamParser();
  const picked = [...new Set([init, todo, result, assistant].filter((i) => i >= 0))].sort((a, b) => a - b);
  for (const i of picked) parser.push(JSON.stringify(events[i].event));
  const initEvent = init >= 0 ? events[init].event : null;
  const names = [initEvent?.slash_commands, initEvent?.skills];
  const slashCommands = names.some(Array.isArray)
    ? [...new Set(names.flatMap((list) => (Array.isArray(list) ? list : []))
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.replace(/^\/+/, ''))
      .filter(Boolean))].sort()
    : null;
  let contextUsage = parser.contextUsage;
  if (contextUsage && parser.model) {
    if (contextUsage.windowKnown) {
      rememberContextWindow(parser.model, contextUsage.contextWindow);
    } else {
      const contextWindow = knownContextWindow(parser.model);
      if (contextWindow !== null) {
        contextUsage = {
          ...contextUsage,
          contextWindow,
          fraction: Math.min(1, contextUsage.usedTokens / contextWindow),
          windowKnown: true,
        };
      }
    }
  }
  return { todos: parser.todos, contextUsage, slashCommands };
}

export interface ChatTotals {
  /** Turns that reached a result. */
  turns: number;
  /** Null when no turn reported a cost (Codex does not). */
  costUsd: number | null;
  /** Prompt tokens, cache reads and writes included: what the model read. */
  inputTokens: number;
  /** Prompt tokens read from the prompt cache. */
  cachedInputTokens: number;
  outputTokens: number;
}

/** One chat's spend, added up over every turn's result. */
export function chatTotals(events: WorkbenchEvent[]): ChatTotals {
  const totals: ChatTotals = { turns: 0, costUsd: null, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  for (const { event } of events) {
    if (event.type !== 'result') continue;
    totals.turns += 1;
    if (typeof event.total_cost_usd === 'number') totals.costUsd = (totals.costUsd ?? 0) + event.total_cost_usd;
    const usage = (event.usage ?? {}) as {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    totals.inputTokens +=
      (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    totals.cachedInputTokens += usage.cache_read_input_tokens ?? 0;
    totals.outputTokens += usage.output_tokens ?? 0;
  }
  return totals;
}

/** 950 → "950", 48213 → "48.2k", 1_204_000 → "1.2M". */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

// ============================================================================
// The next action
// ============================================================================

/** The fields of a PR the next action reads. */
export interface WorkbenchPrLike {
  state: PRState;
  summary: Pick<PRSummaryShape, 'mergeable' | 'ciStatus' | 'url'> & Partial<PRSummaryShape>;
}

/**
 * Talyn's PR summary as the shared next-action input. A row with no CI verdict
 * (written before the field shipped) keeps it absent, which reads as Merge.
 */
export function nextActionInput(workbench: Pick<Workbench, 'diffStat'>, pr: WorkbenchPrLike | null): WorkbenchNextActionInput {
  const hasChanges = (workbench.diffStat?.files ?? 0) > 0;
  if (!pr) return { hasChanges, pr: null };
  return {
    hasChanges,
    pr: prSummaryToNextActionPr({ state: pr.state, mergeable: pr.summary.mergeable, ciStatus: pr.summary.ciStatus }),
  };
}

export function workbenchNextAction(workbench: Pick<Workbench, 'diffStat'>, pr: WorkbenchPrLike | null): WorkbenchNextAction {
  return nextWorkbenchAction(nextActionInput(workbench, pr));
}

export const NEXT_ACTION_LABEL: Record<Exclude<WorkbenchNextAction, null>, string> = {
  create_pr: 'Create PR',
  resolve_conflicts: 'Resolve conflicts',
  fix_checks: 'Fix checks',
  merge: 'Merge',
  archive: 'Archive',
};

export function prRowAsLike(row: PRRow): WorkbenchPrLike {
  return { state: row.state, summary: row.summary };
}

// ============================================================================
// Diff comments
// ============================================================================

export interface DiffComment {
  id: string;
  path: string;
  side: 'additions' | 'deletions';
  startLine: number;
  endLine: number;
  text: string;
}

function lineLabel(c: DiffComment): string {
  const range = c.startLine === c.endLine ? `line ${c.startLine}` : `lines ${c.startLine}-${c.endLine}`;
  return c.side === 'deletions' ? `${range} (removed side)` : range;
}

/**
 * The one message a tray of diff comments becomes. Grouped by file, in the
 * order the files were first commented on, each comment with its line range.
 */
export function formatCommentsMessage(comments: DiffComment[]): string {
  if (comments.length === 0) return '';
  const byPath = new Map<string, DiffComment[]>();
  for (const c of comments) {
    const list = byPath.get(c.path);
    if (list) list.push(c);
    else byPath.set(c.path, [c]);
  }
  const lines = [
    comments.length === 1
      ? 'I left a comment on the diff. Address it:'
      : `I left ${comments.length} comments on the diff. Address each one:`,
  ];
  for (const [path, list] of byPath) {
    lines.push('', `\`${path}\``);
    for (const c of [...list].sort((a, b) => a.startLine - b.startLine)) {
      const text = c.text.trim().replace(/\n+/g, '\n  ');
      lines.push(`- ${lineLabel(c)}: ${text}`);
    }
  }
  return lines.join('\n');
}

// ============================================================================
// Files
// ============================================================================

export interface FileTreeNode {
  name: string;
  path: string;
  children: FileTreeNode[] | null;
}

/** A sorted tree from flat paths: folders first, then files, each alphabetical. */
export function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: FileTreeNode = { name: '', path: '', children: [] };
  for (const full of paths) {
    const parts = full.split('/').filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join('/');
      const children = node.children ?? (node.children = []);
      let child = children.find((c) => c.name === part && (c.children === null) === isFile);
      if (!child) {
        child = { name: part, path, children: isFile ? null : [] };
        children.push(child);
      }
      node = child;
    });
  }
  const sort = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => {
      const af = a.children === null ? 1 : 0;
      const bf = b.children === null ? 1 : 0;
      return af - bf || a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.children) sort(n.children);
  };
  sort(root.children ?? []);
  return root.children ?? [];
}

/**
 * Fuzzy file match for the `@` popover: every query character in order,
 * scored so a hit in the file name beats a hit in the directory and a
 * contiguous run beats a scattered one.
 */
export function fuzzyMatchPaths(query: string, paths: string[], limit = 20): string[] {
  const q = query.toLowerCase();
  if (!q) return paths.slice(0, limit);
  const scored: Array<{ path: string; score: number }> = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const nameStart = lower.lastIndexOf('/') + 1;
    let score = 0;
    let pos = -1;
    let ok = true;
    for (const ch of q) {
      const next = lower.indexOf(ch, pos + 1);
      if (next === -1) {
        ok = false;
        break;
      }
      score += next === pos + 1 ? 3 : 1;
      if (next >= nameStart) score += 2;
      pos = next;
    }
    if (!ok) continue;
    if (lower.slice(nameStart).startsWith(q)) score += 10;
    scored.push({ path, score: score - path.length / 100 });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.path);
}

// Claude Code built-ins that work in print mode, shown until the first turn reports the real list.
export const CLAUDE_HEADLESS_SLASH_COMMANDS = ['compact', 'context', 'cost', 'init', 'pr-comments', 'release-notes', 'review', 'security-review'];

/** Slash commands and skills from Claude files. */
export function slashCommandsFrom(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const command = /^\.claude\/commands\/(.+)\.md$/.exec(p);
    const skill = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(p);
    if (command) out.add(command[1].replace(/\//g, ':'));
    if (skill) out.add(skill[1]);
  }
  return [...out].sort();
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
