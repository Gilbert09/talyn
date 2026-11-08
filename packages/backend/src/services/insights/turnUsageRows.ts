/**
 * Pure: one turn's result events → the `workbench_turn_usage` rows.
 *
 * The two agents report usage differently, and getting that wrong is how a
 * token chart lies:
 *
 *  - Claude Code: each result event is one `claude -p` run. `usage` is that
 *    run's own total, `input_tokens` EXCLUDES the cache, and `modelUsage`
 *    splits it per model with a `costUSD` estimate each. A turn that ran twice
 *    (a relaunch) has two result events, and both runs spent tokens: add them.
 *  - Codex: `turn.completed` carries the THREAD's running total, across turns
 *    and resumes (`codex exec resume` keeps counting), and `input_tokens`
 *    INCLUDES the cached tokens. One turn's use is this total minus the last
 *    total before it. A new thread (a different `session_id`, or any counter
 *    that went down) starts again from zero. No cost is reported.
 */

import { FLEET_MODELS, fleetProviderForModel } from '@talyn/shared';

export interface StoredResultUsage {
  seq: number;
  at: Date;
  sessionId: string | null;
  usage: Record<string, unknown> | null;
  modelUsage: Record<string, unknown> | null;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  isError: boolean;
}

export interface TurnFacts {
  turn: number;
  startedAt: Date;
  endedAt: Date;
  /** The model named by the turn's `system/init` event (Claude). */
  initModel: string | null;
  /** The agent that ran the turn, from its `system/init` event. Null: no init event. */
  initAgent?: 'claude' | 'codex' | null;
  /**
   * The model Talyn launched the turn with, stamped on its user message. Null:
   * the agent's default. Undefined: a turn from before the stamp.
   */
  turnModel?: string | null;
  /** When the backend received the turn's user message. */
  sentAt: Date | null;
  /** The first assistant event after that message. */
  replyAt: Date | null;
  results: StoredResultUsage[];
}

export interface ChatFacts {
  chatId: string;
  workbenchId: string;
  workspaceId: string;
  agent: string;
  /** The chat's model. Null: the session's model, or the agent's default. */
  model: string | null;
  /** The session's agent and model. They apply only to a chat on the session's agent. */
  sessionAgent?: string | null;
  sessionModel?: string | null;
}

export interface TurnUsageRow {
  chatId: string;
  turn: number;
  model: string;
  workspaceId: string;
  workbenchId: string;
  agent: string;
  isPrimary: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costEstimateMicros: number | null;
  durationMs: number | null;
  agentSteps: number | null;
  firstReplyMs: number | null;
  isError: boolean;
  endedAt: Date;
}

/** The model a row is stored under when nothing names one. */
export const UNKNOWN_MODEL = 'unknown';

interface Tokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface ModelTotals extends Tokens {
  costMicros: number | null;
}

/**
 * A Claude Code alias (`sonnet`, `opus`, `fable`) as the newest model of that
 * family, so it is not a row of its own.
 */
const CLAUDE_ALIASES: Record<string, string> = Object.fromEntries(
  ['fable', 'opus', 'sonnet', 'haiku'].flatMap((family) => {
    const newest = FLEET_MODELS.find((m) => m.provider === 'anthropic' && m.id.startsWith(`claude-${family}-`));
    return newest ? [[family, newest.id]] : [];
  }),
);

/** True when `model` is clearly the other vendor's, so it cannot have run on `agent`. */
function otherVendorModel(agent: 'claude' | 'codex', model: string): boolean {
  if (agent === 'codex') return /^(claude|sonnet|opus|haiku|fable)\b/i.test(model);
  return /^gpt-/i.test(model) || fleetProviderForModel(model) === 'openai';
}

/** A configured model as Insights stores it: aliases resolved, other-vendor ids dropped. */
function configuredModel(agent: 'claude' | 'codex', model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed || otherVendorModel(agent, trimmed)) return null;
  return agent === 'claude' ? CLAUDE_ALIASES[trimmed.toLowerCase()] ?? trimmed : trimmed;
}

/**
 * The model a turn ran on when its own events do not say: the stamp on its
 * user message, else what the chat and session say now. This mirrors the
 * launcher (`turnModelFor`): the session's model applies only to a chat on
 * the session's agent.
 */
export function configuredTurnModel(agent: 'claude' | 'codex', chat: ChatFacts, facts: TurnFacts): string | null {
  if (facts.turnModel !== undefined) return configuredModel(agent, facts.turnModel);
  return configuredModel(agent, chat.model)
    ?? (chat.sessionAgent === undefined || chat.sessionAgent === agent ? configuredModel(agent, chat.sessionModel) : null);
}

const zero = (): Tokens => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

/** A non-negative integer from an untrusted number, else 0. */
function count(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function dollarsToMicros(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000) : null;
}

const addCost = (a: number | null, b: number | null): number | null => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));

/** Claude's per-run `usage` (snake_case). */
function claudeUsage(usage: Record<string, unknown> | null): Tokens {
  if (!usage) return zero();
  return {
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheWriteTokens: count(usage.cache_creation_input_tokens),
  };
}

/** Claude's `modelUsage` entry (camelCase). */
function claudeModelEntry(entry: unknown): ModelTotals | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const e = entry as Record<string, unknown>;
  return {
    inputTokens: count(e.inputTokens),
    outputTokens: count(e.outputTokens),
    cacheReadTokens: count(e.cacheReadInputTokens),
    cacheWriteTokens: count(e.cacheCreationInputTokens),
    costMicros: dollarsToMicros(e.costUSD),
  };
}

/** Codex's thread totals, as the parser stores them. */
export function codexTotals(usage: Record<string, unknown> | null): Tokens & { rawInput: number } {
  const rawInput = count(usage?.input_tokens);
  const cacheReadTokens = count(usage?.cache_read_input_tokens);
  return {
    rawInput,
    // Codex counts cached tokens inside input_tokens; store the fresh part only.
    inputTokens: Math.max(0, rawInput - cacheReadTokens),
    outputTokens: count(usage?.output_tokens),
    cacheReadTokens,
    cacheWriteTokens: count(usage?.cache_creation_input_tokens),
  };
}

/**
 * One Codex result's own usage, given the result before it in the chat.
 * The difference only when both are the same thread and no counter went down.
 */
export function codexDelta(current: StoredResultUsage, previous: StoredResultUsage | null): Tokens {
  const now = codexTotals(current.usage);
  const own = { inputTokens: now.inputTokens, outputTokens: now.outputTokens, cacheReadTokens: now.cacheReadTokens, cacheWriteTokens: now.cacheWriteTokens };
  if (!previous || !previous.usage) return own;
  if (current.sessionId && previous.sessionId && current.sessionId !== previous.sessionId) return own;
  const before = codexTotals(previous.usage);
  const grew = now.rawInput >= before.rawInput && now.outputTokens >= before.outputTokens
    && now.cacheReadTokens >= before.cacheReadTokens && now.cacheWriteTokens >= before.cacheWriteTokens;
  if (!grew) return own;
  const cacheReadTokens = now.cacheReadTokens - before.cacheReadTokens;
  return {
    inputTokens: Math.max(0, now.rawInput - before.rawInput - cacheReadTokens),
    outputTokens: now.outputTokens - before.outputTokens,
    cacheReadTokens,
    cacheWriteTokens: now.cacheWriteTokens - before.cacheWriteTokens,
  };
}

function tokenSum(t: Tokens): number {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
}

/**
 * The rows of one turn. Empty when the turn has no result event (a cancelled
 * turn reports nothing, so it is not counted).
 *
 * `previousCodexResult` is the last result event of the chat BEFORE this turn;
 * only a Codex chat reads it.
 */
export function buildTurnUsageRows(chat: ChatFacts, facts: TurnFacts, previousCodexResult: StoredResultUsage | null = null): TurnUsageRow[] {
  const results = [...facts.results].sort((a, b) => a.seq - b.seq);
  if (results.length === 0) return [];
  const perModel = new Map<string, ModelTotals>();
  const add = (model: string, tokens: Tokens, costMicros: number | null) => {
    const prev = perModel.get(model) ?? { ...zero(), costMicros: null };
    perModel.set(model, {
      inputTokens: prev.inputTokens + tokens.inputTokens,
      outputTokens: prev.outputTokens + tokens.outputTokens,
      cacheReadTokens: prev.cacheReadTokens + tokens.cacheReadTokens,
      cacheWriteTokens: prev.cacheWriteTokens + tokens.cacheWriteTokens,
      costMicros: addCost(prev.costMicros, costMicros),
    });
  };
  // The turn's own init event names its agent; the chat may have switched since.
  const agent = facts.initAgent ?? (chat.agent === 'codex' ? 'codex' : 'claude');
  const fallbackModel = (agent === 'codex' ? null : facts.initModel) ?? configuredTurnModel(agent, chat, facts) ?? UNKNOWN_MODEL;
  let agentSteps: number | null = null;
  let resultDurationMs: number | null = null;
  // Cost the per-model entries did not carry, kept for the main model.
  let unassignedCost: number | null = null;

  if (agent === 'codex') {
    let previous = previousCodexResult;
    for (const result of results) {
      add(fallbackModel, codexDelta(result, previous), null);
      previous = result;
    }
  } else {
    for (const result of results) {
      const entries = result.modelUsage && typeof result.modelUsage === 'object'
        ? Object.entries(result.modelUsage).map(([model, entry]) => [model, claudeModelEntry(entry)] as const)
          .filter((e): e is readonly [string, ModelTotals] => e[1] !== null && e[0].length > 0)
        : [];
      const total = dollarsToMicros(result.costUsd);
      if (entries.length > 0) {
        for (const [model, entry] of entries) add(model, entry, entry.costMicros);
        if (entries.every(([, e]) => e.costMicros === null)) unassignedCost = addCost(unassignedCost, total);
      } else {
        add(fallbackModel, claudeUsage(result.usage), null);
        unassignedCost = addCost(unassignedCost, total);
      }
      if (result.numTurns !== null) agentSteps = (agentSteps ?? 0) + count(result.numTurns);
      if (result.durationMs !== null) resultDurationMs = (resultDurationMs ?? 0) + count(result.durationMs);
    }
  }

  // The main model: the one the turn started on, else the one that did the most.
  const models = [...perModel.keys()];
  const primary = facts.initModel && perModel.has(facts.initModel)
    ? facts.initModel
    : models.reduce((best, m) => (tokenSum(perModel.get(m)!) > tokenSum(perModel.get(best)!) ? m : best), models[0]);

  const last = results[results.length - 1];
  const durationMs = resultDurationMs ?? Math.max(0, facts.endedAt.getTime() - facts.startedAt.getTime());
  const firstReplyMs = facts.sentAt && facts.replyAt && facts.replyAt.getTime() >= facts.sentAt.getTime()
    ? facts.replyAt.getTime() - facts.sentAt.getTime()
    : null;

  return models.map((model) => {
    const totals = perModel.get(model)!;
    const isPrimary = model === primary;
    return {
      chatId: chat.chatId,
      turn: facts.turn,
      model,
      workspaceId: chat.workspaceId,
      workbenchId: chat.workbenchId,
      agent,
      isPrimary,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      costEstimateMicros: isPrimary ? addCost(totals.costMicros, unassignedCost) : totals.costMicros,
      durationMs: isPrimary ? durationMs : null,
      agentSteps: isPrimary ? agentSteps : null,
      firstReplyMs: isPrimary ? firstReplyMs : null,
      isError: isPrimary ? results.some((r) => r.isError) : false,
      endedAt: last.at,
    };
  });
}

/** Parse one element of the SQL `results` array (see `turnUsage.ts`). */
export function parseStoredResult(raw: unknown): StoredResultUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const seq = Number(r.seq);
  const at = new Date(String(r.at));
  if (!Number.isFinite(seq) || Number.isNaN(at.getTime())) return null;
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    seq,
    at,
    sessionId: typeof r.sessionId === 'string' && r.sessionId ? r.sessionId : null,
    usage: obj(r.usage),
    modelUsage: obj(r.modelUsage),
    costUsd: num(r.cost),
    durationMs: num(r.durationMs),
    numTurns: num(r.numTurns),
    isError: r.isError === true || (typeof r.subtype === 'string' && r.subtype !== 'success'),
  };
}
