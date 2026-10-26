import {
  externalQueueStatusFromLabels,
  type ExternalQueueState,
  type MergeEtaAnswer,
  type MergeEtaReason,
} from '@talyn/shared';
import { peekExternalQueueState } from '../externalQueueState.js';
import {
  getSubmittedPullRequest,
  TrunkAuthError,
  TrunkNotFoundError,
} from './client.js';
import {
  clearTrunkReauth,
  getTrunkCredentials,
  markTrunkReauthRequired,
} from './credentials.js';
import { parseTrunkSubmittedPullRequest } from './parse.js';

/**
 * The answer behind `GET /pull-requests/:id/merge-eta`.
 *
 * There is no poll loop. A client asks while the PR is on screen, and each
 * answer is kept for {@link CACHE_TTL_MS} in memory, so any number of open
 * clients cost one Trunk call a minute per PR. Concurrent asks for the same PR
 * share one call.
 */

/** Matches the clients' own refresh, so a refresh always finds a fresh answer. */
export const CACHE_TTL_MS = 60_000;

/** The PR facts the answer needs. Read through `MERGE_ETA_COLUMNS`. */
export interface MergeEtaPr {
  id: string;
  workspaceId: string;
  owner: string;
  repo: string;
  number: number;
  state: string;
  /** The branch the PR lands on (a stack's base, else its own base). */
  landingBranch: string | null;
  labels: unknown;
}

/**
 * States that say Trunk does not have the PR. When Talyn already knows one of
 * these, asking Trunk would only confirm it.
 */
const OUT_OF_QUEUE: ReadonlySet<ExternalQueueState> = new Set<ExternalQueueState>([
  'not_submitted',
  'failed',
  'ejected',
  'cancelled',
  'rejected',
  'merged',
]);

const answers = new Map<string, { answer: MergeEtaAnswer; expiresAt: number }>();
const inflight = new Map<string, Promise<MergeEtaAnswer>>();

// The token is part of the key, so an answer fetched with a replaced token is
// never served for the new one.
function cacheKey(workspaceId: string, prId: string, tokenFingerprint: string): string {
  return `${workspaceId}:${prId}:${tokenFingerprint.slice(0, 16)}`;
}

function none(reason: MergeEtaReason, extra: Partial<MergeEtaAnswer> = {}): MergeEtaAnswer {
  return { eta: null, reason, ...extra, fetchedAt: new Date().toISOString() };
}

function labelsOf(raw: unknown): string[] | undefined {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  return Array.isArray(raw) ? raw.filter((l): l is string => typeof l === 'string') : undefined;
}

/** What Talyn already knows, without a GitHub call: the comment cache, then labels. */
function knownExternalState(pr: MergeEtaPr): ExternalQueueState | null {
  const observed = peekExternalQueueState(pr.owner, pr.repo, pr.number);
  if (observed) return observed.state;
  return externalQueueStatusFromLabels(labelsOf(pr.labels))?.state ?? null;
}

function prune(now: number): void {
  for (const [key, entry] of answers) {
    if (entry.expiresAt <= now) answers.delete(key);
  }
}

export async function mergeEtaForPr(pr: MergeEtaPr): Promise<MergeEtaAnswer> {
  const creds = await getTrunkCredentials(pr.workspaceId);
  if (!creds) return none('no_token');

  if (pr.state !== 'open' || !pr.landingBranch) return none('not_queued');
  const known = knownExternalState(pr);
  if (known && OUT_OF_QUEUE.has(known)) return none('not_queued');

  const key = cacheKey(pr.workspaceId, pr.id, creds.tokenFingerprint);
  const now = Date.now();
  const hit = answers.get(key);
  if (hit && hit.expiresAt > now) return hit.answer;

  const pending = inflight.get(key);
  if (pending) return pending;

  const call = askTrunk(pr, creds)
    .then((answer) => {
      const at = Date.now();
      prune(at);
      answers.set(key, { answer, expiresAt: at + CACHE_TTL_MS });
      return answer;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, call);
  return call;
}

async function askTrunk(
  pr: MergeEtaPr,
  creds: NonNullable<Awaited<ReturnType<typeof getTrunkCredentials>>>
): Promise<MergeEtaAnswer> {
  let raw: unknown;
  try {
    raw = await getSubmittedPullRequest(
      creds.token,
      { owner: pr.owner, repo: pr.repo, number: pr.number, targetBranch: pr.landingBranch ?? '' },
      { workspaceId: pr.workspaceId }
    );
  } catch (err) {
    if (err instanceof TrunkAuthError) {
      if (!creds.reauthRequired) {
        await markTrunkReauthRequired(pr.workspaceId, creds.tokenFingerprint, err.message).catch(
          (e) => console.warn('[trunk] could not record the refused token:', e instanceof Error ? e.message : e)
        );
      }
      return none('reauth_required');
    }
    if (err instanceof TrunkNotFoundError) return none('not_queued');
    console.warn(
      `[trunk] merge ETA for ${pr.owner}/${pr.repo}#${pr.number} failed:`,
      err instanceof Error ? err.message : err
    );
    return none('unavailable');
  }

  if (creds.reauthRequired) {
    await clearTrunkReauth(pr.workspaceId, creds.tokenFingerprint).catch((e) =>
      console.warn('[trunk] could not clear the reconnect marker:', e instanceof Error ? e.message : e)
    );
  }

  const parsed = parseTrunkSubmittedPullRequest(raw);
  const extra: Partial<MergeEtaAnswer> = {
    ...(parsed.queueState ? { queueState: parsed.queueState } : {}),
    ...(parsed.stateChangedAt ? { stateChangedAt: parsed.stateChangedAt } : {}),
  };
  const done =
    parsed.queueState === 'merged' ||
    parsed.queueState === 'failed' ||
    parsed.queueState === 'cancelled';
  if (parsed.isCurrentlySubmitted === false || done) return none('not_queued', extra);
  if (!parsed.eta) return none('no_estimate', extra);
  return { eta: parsed.eta, ...extra, fetchedAt: new Date().toISOString() };
}

/** Drop cached answers for a workspace, after its token changes. */
export function clearMergeEtaCache(workspaceId?: string): void {
  if (!workspaceId) {
    answers.clear();
    return;
  }
  const prefix = `${workspaceId}:`;
  for (const key of answers.keys()) {
    if (key.startsWith(prefix)) answers.delete(key);
  }
}
