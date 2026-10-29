import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { SlackRepoChoiceReason } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { repositories as reposTable, slackRepoMemory, workbenches, workspaces } from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { githubService } from '../github.js';

/**
 * Which repository a Slack request is about.
 *
 * Tried in order, each step only among what the step before could not split:
 *  1. explicit: a GitHub URL or `owner/repo` that names a connected repository;
 *  2. name: a repository's name (or an alias) as a whole word;
 *  3. memory: what this channel's sessions used (a person's correction weighs
 *     double), then the user's own recent sessions at a lower weight;
 *  4. code search, only as a tie-break, only with distinctive tokens, at most
 *     {@link MAX_CODE_SEARCHES} searches.
 * No clear winner means NO guess: the caller asks the user.
 *
 * "Clear" ({@link isClear}): the best score is at least {@link CLEAR_RATIO}
 * times the runner-up's (a runner-up of 0 always loses). A tie, or 3 against
 * 2, is not clear. Memory also needs {@link MEMORY_MIN_SCORE}, so a single
 * old session cannot decide alone.
 */

export interface ResolverRepo {
  id: string;
  /** `owner/name`, any case. */
  fullName: string;
}

export interface ChannelMemory {
  repositoryId: string;
  uses: number;
  corrections: number;
}

export interface ResolverInput {
  repos: ResolverRepo[];
  /** The request: the user's instruction and the quoted request message. */
  request: string;
  /** The other thread messages, as plain text. */
  thread: string[];
  /** Learned aliases per repository id. Optional: nothing feeds it yet. */
  aliases?: Map<string, string[]>;
  channelMemory: ChannelMemory[];
  /** Repository ids of the user's most recent sessions, newest first. */
  recentSessions: string[];
}

export type RepoResolution =
  | { kind: 'chosen'; repositoryId: string; reason: SlackRepoChoiceReason; detail: string }
  | { kind: 'ambiguous'; candidates: string[]; detail: string };

/** The undecided state after steps 1-3: who is left, and what code search could look for. */
export interface OfflineUndecided {
  kind: 'undecided';
  contenders: string[];
  searchQueries: string[];
  detail: string;
}

export const CLEAR_RATIO = 2;
/** A mention in the request outweighs one in the thread: the request is what the user asked for. */
export const REQUEST_WEIGHT = 3;
export const THREAD_WEIGHT = 1;
/** A correction (a person picked or changed the repository) counts as two uses. */
export const CORRECTION_WEIGHT = 2;
/** One of the user's own recent sessions, from any channel or the app. */
export const RECENT_SESSION_WEIGHT = 0.5;
/** How many of the user's sessions count as "recent": enough to show what they work on now. */
export const RECENT_SESSIONS = 10;
/** Two channel uses, one correction, or four recent sessions. */
export const MEMORY_MIN_SCORE = 2;
/** Code search has a 10-a-minute budget shared with everything else on the account. */
export const MAX_CODE_SEARCHES = 2;
/**
 * A name this short is an ordinary word too often (`api`, `app`, `web`) to
 * mean the repository by itself. The `owner/name` form still works for it.
 */
export const MIN_NAME_LENGTH = 4;
/** GitHub refuses a code search whose text is longer than 256 characters. */
const MAX_SEARCH_TERM = 120;

type Scores = Map<string, number>;

/** Best first; ties keep input order. */
function ranked(scores: Scores): Array<[string, number]> {
  return [...scores.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
}

export function isClear(scores: Scores, minimum = 0): { winner: string; top: number } | null {
  const r = ranked(scores);
  if (r.length === 0 || r[0][1] < minimum || r[0][1] <= 0) return null;
  const second = r[1]?.[1] ?? 0;
  return r[0][1] >= second * CLEAR_RATIO && r[0][1] > second ? { winner: r[0][0], top: r[0][1] } : null;
}

/** The repositories still in the running after a step with evidence but no winner. */
function contendersOf(scores: Scores): string[] {
  const r = ranked(scores);
  if (r.length === 0) return [];
  return r.filter(([, v]) => v * CLEAR_RATIO > r[0][1]).map(([id]) => id);
}

// ---------------------------------------------------------------------------
// Step 1: explicit references
// ---------------------------------------------------------------------------

/** The `owner/repo` of every GitHub URL in a text (repo, PR, issue, blob…), lower-cased. */
export function githubUrlRepoRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/github\.com[/:]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?=[/#?|>)\s,;:'"]|$)/g)) {
    out.add(`${m[1]}/${m[2]}`.toLowerCase());
  }
  return [...out];
}

/**
 * Every `owner/repo` a text names, lower-cased: GitHub URLs, then bare
 * `owner/repo`. A bare pair is often a path (`src/app`) or prose
 * (`client/server`), so only a match against a CONNECTED repository counts.
 */
export function explicitRepoRefs(text: string): string[] {
  const out = new Set<string>(githubUrlRepoRefs(text));
  const withoutUrls = text.replace(/https?:\/\/\S+/g, ' ');
  for (const m of withoutUrls.matchAll(/(?<![\w./-])([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]*[A-Za-z0-9_-])(?![\w/-])/g)) {
    out.add(`${m[1]}/${m[2]}`.toLowerCase());
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Step 2: names and aliases as whole words
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The ways a repository's name is written in prose: `talyn-fleet`, `talyn fleet`, `talyn_fleet`. */
export function nameVariants(name: string): string[] {
  const lower = name.toLowerCase();
  const spaced = lower.replace(/[-_.]+/g, ' ').trim();
  const out = new Set([lower, spaced, lower.replace(/[-_.]+/g, '-'), lower.replace(/[-_.]+/g, '_')]);
  return [...out].filter((v) => v.length >= MIN_NAME_LENGTH);
}

/**
 * Whether `phrase` appears as a whole word: not inside another word, a path
 * (`src/talyn`) or a dotted name (`posthog.com` does not mention `posthog`).
 */
export function hasWholeWord(text: string, phrase: string): boolean {
  if (!phrase) return false;
  const re = new RegExp(`(?<![\\w./-])${escapeRegExp(phrase).replace(/ /g, '\\s+')}(?![\\w/-])(?!\\.\\w)`, 'i');
  return re.test(text);
}

// ---------------------------------------------------------------------------
// Step 4: distinctive tokens for code search
// ---------------------------------------------------------------------------

const PATH_EXT = '(?:tsx?|jsx?|mjs|cjs|py|go|rs|rb|java|kt|swift|cs|cpp|cc|c|h|hpp|php|scala|sql|ya?ml|toml|json|md|sh|vue|svelte|css|scss|proto|tf)';

/**
 * Search queries for the tokens that would actually tell repositories apart,
 * most distinctive first: file names (as `filename:`), quoted strings (error
 * messages), then CamelCase or snake_case identifiers of 8+ characters.
 * Ordinary words never qualify.
 */
export function distinctiveSearchQueries(text: string): string[] {
  const out: string[] = [];
  const add = (q: string) => {
    if (!out.includes(q)) out.push(q);
  };
  let noUrls = text.replace(/https?:\/\/\S+/g, ' ');

  const pathRe = new RegExp(`(?<![\\w.-])((?:[\\w.-]+/)*[\\w-]+\\.${PATH_EXT})(?![\\w])`, 'g');
  for (const m of noUrls.matchAll(pathRe)) {
    const base = m[1].split('/').pop() as string;
    add(`filename:${base}`);
  }
  // A path's parts are not identifiers of their own.
  noUrls = noUrls.replace(pathRe, ' ');
  for (const m of noUrls.matchAll(/[`"]([^`"\n]{8,})[`"]/g)) {
    const term = m[1].trim().slice(0, MAX_SEARCH_TERM).replace(/"/g, ' ').trim();
    if (term.length >= 8 && !/^(?:[\w-]+\/)*[\w-]+\.\w+$/.test(term)) add(`"${term}"`);
  }
  for (const m of noUrls.matchAll(/(?<![\w.])([A-Za-z_][A-Za-z0-9_]{7,})(?![\w])/g)) {
    const id = m[1];
    const camel = /[a-z][A-Z]/.test(id);
    const snake = /[a-z0-9]_[a-z0-9]/i.test(id);
    if (camel || snake) add(`"${id}"`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The pure core: steps 1-3
// ---------------------------------------------------------------------------

function fullName(r: ResolverRepo): string {
  return r.fullName.toLowerCase();
}

function shortName(r: ResolverRepo): string {
  return fullName(r).split('/').pop() ?? '';
}

export function resolveRepoOffline(input: ResolverInput): Extract<RepoResolution, { kind: 'chosen' | 'ambiguous' }> | OfflineUndecided {
  const repos = input.repos;
  if (repos.length === 0) return { kind: 'ambiguous', candidates: [], detail: 'The workspace has no connected repositories.' };
  const byFull = new Map(repos.map((r) => [fullName(r), r]));
  const name = (id: string) => repos.find((r) => r.id === id)?.fullName ?? id;
  let pool = repos.map((r) => r.id);
  const notes: string[] = [];

  // 1. Explicit references.
  const explicit: Scores = new Map();
  const unconnected = new Set<string>();
  const credit = (text: string, weight: number) => {
    for (const ref of explicitRepoRefs(text)) {
      const repo = byFull.get(ref);
      if (repo) explicit.set(repo.id, (explicit.get(repo.id) ?? 0) + weight);
    }
  };
  // Only a GitHub URL is a reliable pointer to a repository this workspace
  // lacks; a bare pair is too often a path.
  for (const ref of githubUrlRepoRefs(input.request)) if (!byFull.has(ref)) unconnected.add(ref);
  credit(input.request, REQUEST_WEIGHT);
  for (const t of input.thread) credit(t, THREAD_WEIGHT);
  const explicitWin = isClear(explicit);
  if (explicitWin) {
    return { kind: 'chosen', repositoryId: explicitWin.winner, reason: 'explicit', detail: `The request names ${name(explicitWin.winner)}.` };
  }
  if (explicit.size > 0) {
    pool = contendersOf(explicit);
    notes.push(`it names ${pool.map(name).join(' and ')}`);
  }

  // 2. Names and aliases as whole words.
  const named: Scores = new Map();
  for (const id of pool) {
    const repo = repos.find((r) => r.id === id) as ResolverRepo;
    const phrases = [...nameVariants(shortName(repo)), ...(input.aliases?.get(id) ?? []).map((a) => a.toLowerCase())];
    const mentions = (text: string) => phrases.some((p) => hasWholeWord(text, p));
    let score = mentions(input.request) ? REQUEST_WEIGHT : 0;
    for (const t of input.thread) if (mentions(t)) score += THREAD_WEIGHT;
    if (score > 0) named.set(id, score);
  }
  const nameWin = isClear(named);
  if (nameWin) {
    return { kind: 'chosen', repositoryId: nameWin.winner, reason: 'name', detail: `The request mentions "${shortName(repos.find((r) => r.id === nameWin.winner) as ResolverRepo)}".` };
  }
  if (named.size > 0) {
    pool = contendersOf(named);
    notes.push(`it mentions ${pool.map(name).join(' and ')}`);
  } else if (unconnected.size > 0 && explicit.size === 0) {
    // It points at a repository this workspace does not have. Choosing another
    // one would be a guess, so ask.
    return {
      kind: 'ambiguous',
      candidates: [],
      detail: `The request names ${[...unconnected].join(', ')}, which is not connected to this workspace.`,
    };
  }

  // 3. Memory: this channel, then the user's recent sessions.
  const memory: Scores = new Map();
  const inPool = new Set(pool);
  for (const m of input.channelMemory) {
    if (!inPool.has(m.repositoryId)) continue;
    memory.set(m.repositoryId, (memory.get(m.repositoryId) ?? 0) + m.uses + CORRECTION_WEIGHT * m.corrections);
  }
  for (const id of input.recentSessions.slice(0, RECENT_SESSIONS)) {
    if (inPool.has(id)) memory.set(id, (memory.get(id) ?? 0) + RECENT_SESSION_WEIGHT);
  }
  const memoryWin = isClear(memory, MEMORY_MIN_SCORE);
  if (memoryWin) {
    return {
      kind: 'chosen',
      repositoryId: memoryWin.winner,
      reason: 'memory',
      detail: `Recent sessions from this channel and by you used ${name(memoryWin.winner)}.`,
    };
  }

  if (pool.length === 1 && repos.length === 1 && explicit.size === 0 && named.size === 0) {
    return { kind: 'chosen', repositoryId: pool[0], reason: 'only_repository', detail: `${name(pool[0])} is the only repository.` };
  }

  return {
    kind: 'undecided',
    contenders: pool,
    searchQueries: distinctiveSearchQueries([input.request, ...input.thread].join('\n')).slice(0, MAX_CODE_SEARCHES),
    detail: notes.length > 0 ? `No clear repository: ${notes.join('; ')}.` : 'Nothing in the request points at a repository.',
  };
}

/** Step 4 on the hits code search found, summed over the queries. */
export function decideByCodeSearch(
  undecided: OfflineUndecided,
  hits: Scores,
  repos: ResolverRepo[]
): RepoResolution {
  const scores: Scores = new Map();
  for (const id of undecided.contenders) if ((hits.get(id) ?? 0) > 0) scores.set(id, hits.get(id) as number);
  const win = isClear(scores);
  if (win) {
    const name = repos.find((r) => r.id === win.winner)?.fullName ?? win.winner;
    return { kind: 'chosen', repositoryId: win.winner, reason: 'code_search', detail: `Code search found the request's terms in ${name}.` };
  }
  // Best first for the picker: search hits, then the order the steps left.
  const candidates = [...undecided.contenders].sort((a, b) => (hits.get(b) ?? 0) - (hits.get(a) ?? 0));
  return { kind: 'ambiguous', candidates, detail: undecided.detail };
}

// ---------------------------------------------------------------------------
// The IO shell
// ---------------------------------------------------------------------------

export interface ResolveRepoContext {
  workspaceId: string;
  userId: string;
  teamId: string;
  channelId: string;
  request: string;
  thread: string[];
}

export interface ResolvedRepo {
  resolution: RepoResolution;
  repos: ResolverRepo[];
}

/** `owner/name` from a repository URL, as the create path works it out. */
export function repoFullNameFromUrl(url: string, fallback: string): string {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : fallback;
}

export async function resolveRepository(ctx: ResolveRepoContext): Promise<ResolvedRepo> {
  const db = getPoolDbClient();
  const repoRows = await db
    .select({ id: reposTable.id, url: reposTable.url, name: reposTable.name })
    .from(reposTable)
    .where(eq(reposTable.workspaceId, ctx.workspaceId));
  const repos: ResolverRepo[] = repoRows.map((r) => ({ id: r.id, fullName: repoFullNameFromUrl(r.url, r.name) }));
  const ids = repos.map((r) => r.id);

  const [channelMemory, recent] = ids.length === 0
    ? [[], []]
    : await Promise.all([
        db
          .select({ repositoryId: slackRepoMemory.repositoryId, uses: slackRepoMemory.uses, corrections: slackRepoMemory.corrections })
          .from(slackRepoMemory)
          .where(
            and(
              eq(slackRepoMemory.teamId, ctx.teamId),
              eq(slackRepoMemory.channelId, ctx.channelId),
              inArray(slackRepoMemory.repositoryId, ids)
            )
          ),
        db
          .select({ repositoryId: workbenches.repositoryId })
          .from(workbenches)
          .innerJoin(workspaces, eq(workspaces.id, workbenches.workspaceId))
          .where(and(eq(workspaces.ownerId, ctx.userId), inArray(workbenches.repositoryId, ids)))
          .orderBy(desc(workbenches.createdAt))
          .limit(RECENT_SESSIONS),
      ]);

  const offline = resolveRepoOffline({
    repos,
    request: ctx.request,
    thread: ctx.thread,
    channelMemory,
    recentSessions: recent.map((r) => r.repositoryId),
  });
  if (offline.kind !== 'undecided') return { resolution: offline, repos };
  if (offline.searchQueries.length === 0 || offline.contenders.length < 2) {
    return { resolution: { kind: 'ambiguous', candidates: offline.contenders, detail: offline.detail }, repos };
  }

  const names = new Map(offline.contenders.map((id) => [id, repos.find((r) => r.id === id)?.fullName ?? '']));
  const hits: Scores = new Map();
  for (const query of offline.searchQueries.slice(0, MAX_CODE_SEARCHES)) {
    try {
      const byRepo = await githubService.searchCodeHitsByRepo(ctx.workspaceId, query, [...names.values()].filter(Boolean));
      for (const [id, full] of names) {
        const n = byRepo.get(full.toLowerCase()) ?? 0;
        if (n > 0) hits.set(id, (hits.get(id) ?? 0) + n);
      }
    } catch (err) {
      // A tie-break that failed decides nothing; the user is asked instead.
      debugBus.recordEvent({ service: 'slack_events', action: 'code_search_failed', ok: false, summary: query, error: err });
      break;
    }
  }
  return { resolution: decideByCodeSearch(offline, hits, repos), repos };
}

/**
 * Remember that a Slack session from this channel used `repositoryId`. A
 * correction (a person picked or changed it) also counts in `corrections`.
 */
export async function recordRepoUse(input: {
  teamId: string;
  channelId: string;
  repositoryId: string;
  corrected: boolean;
}): Promise<void> {
  const now = new Date();
  await getPoolDbClient()
    .insert(slackRepoMemory)
    .values({
      id: uuid(),
      teamId: input.teamId,
      channelId: input.channelId,
      repositoryId: input.repositoryId,
      uses: 1,
      corrections: input.corrected ? 1 : 0,
      corrected: input.corrected,
      lastUsedAt: now,
    })
    .onConflictDoUpdate({
      target: [slackRepoMemory.teamId, slackRepoMemory.channelId, slackRepoMemory.repositoryId],
      set: {
        uses: sql`${slackRepoMemory.uses} + 1`,
        corrections: input.corrected ? sql`${slackRepoMemory.corrections} + 1` : slackRepoMemory.corrections,
        corrected: input.corrected ? true : slackRepoMemory.corrected,
        lastUsedAt: now,
      },
    });
}
