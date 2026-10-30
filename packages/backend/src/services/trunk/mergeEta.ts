import {
  externalQueueStatusFromLabels,
  type ExternalQueueState,
  type MergeEtaAnswer,
  type MergeEtaReason,
} from '@talyn/shared';
import { peekExternalQueueState } from '../externalQueueState.js';
import {
  clearTrunkPause,
  getQueueEntryEstimate,
  resolvePullRequest,
  resolveRepository,
  trunkKeyHash,
  trunkPauseUntil,
  TrunkAuthError,
  TrunkNotFoundError,
  TrunkRequestError,
} from './client.js';
import {
  clearTrunkReauth,
  getTrunkCredentials,
  isTrunkApiKey,
  markTrunkReauthRequired,
} from './credentials.js';
import { parseTrunkEstimate, parseTrunkPullRequest, parseTrunkRepositoryId } from './parse.js';

/**
 * The answer behind `GET /pull-requests/:id/merge-eta`.
 *
 * There is no poll loop. A client asks while the PR is on screen, and each
 * answer is kept for {@link CACHE_TTL_MS} in memory, so any number of open
 * clients cost one round of Trunk calls a minute per PR. Concurrent asks for
 * the same PR share one round.
 *
 * A round is up to three v2 reads: the repository's Trunk id (cached for
 * {@link REPOSITORY_TTL_MS}, since it does not change), the PR's record, and,
 * only while the PR is in the queue, its estimate.
 */

/** Matches the clients' own refresh, so a refresh always finds a fresh answer. */
export const CACHE_TTL_MS = 60_000;

export const REPOSITORY_TTL_MS = 60 * 60_000;

/** The PR facts the answer needs. Read through `MERGE_ETA_COLUMNS`. */
export interface MergeEtaPr {
  id: string;
  workspaceId: string;
  owner: string;
  repo: string;
  number: number;
  state: string;
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
const repositoryIds = new Map<string, { id: string; expiresAt: number }>();
const repositoryInflight = new Map<string, Promise<string | null>>();

// The key hash separates answers after a key change.
function cacheKey(workspaceId: string, prId: string, keyHash: string): string {
  return `${workspaceId}:${prId}:${keyHash}`;
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
  for (const [key, entry] of repositoryIds) {
    if (entry.expiresAt <= now) repositoryIds.delete(key);
  }
}

export async function mergeEtaForPr(pr: MergeEtaPr): Promise<MergeEtaAnswer> {
  const creds = await getTrunkCredentials(pr.workspaceId);
  if (!creds) return none('no_token');
  if (!isTrunkApiKey(creds.token)) return none('reauth_required');
  if (trunkPauseUntil(creds.token) > Date.now()) return none('unavailable');

  if (pr.state !== 'open') return none('not_queued');
  const known = knownExternalState(pr);
  if (known && OUT_OF_QUEUE.has(known)) return none('not_queued');

  const key = cacheKey(pr.workspaceId, pr.id, trunkKeyHash(creds.token));
  const now = Date.now();
  const hit = answers.get(key);
  if (hit && hit.expiresAt > now) return hit.answer;

  const pending = inflight.get(key);
  if (pending) return pending;

  const call = askTrunk(pr, creds)
    .then((answer) => {
      const at = Date.now();
      prune(at);
      const pause = trunkPauseUntil(creds.token);
      answers.set(key, {
        answer,
        expiresAt: answer.reason === 'unavailable' && pause > at ? pause : at + CACHE_TTL_MS,
      });
      return answer;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, call);
  return call;
}

type Credentials = NonNullable<Awaited<ReturnType<typeof getTrunkCredentials>>>;

async function repositoryIdFor(pr: MergeEtaPr, creds: Credentials): Promise<string | null> {
  const key = `${trunkKeyHash(creds.token)}:${pr.owner.toLowerCase()}/${pr.repo.toLowerCase()}`;
  const hit = repositoryIds.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.id;
  const pending = repositoryInflight.get(key);
  if (pending) return pending;
  const lookup = (async () => {
    try {
      const id = parseTrunkRepositoryId(
        await resolveRepository(creds.token, pr, { workspaceId: pr.workspaceId })
      );
      if (id) repositoryIds.set(key, { id, expiresAt: Date.now() + REPOSITORY_TTL_MS });
      return id;
    } catch (err) {
      if (err instanceof TrunkNotFoundError) throw new TrunkRepositoryAccessError();
      throw err;
    }
  })().finally(() => repositoryInflight.delete(key));
  repositoryInflight.set(key, lookup);
  return lookup;
}

class TrunkRepositoryAccessError extends Error {}

async function askTrunk(pr: MergeEtaPr, creds: Credentials): Promise<MergeEtaAnswer> {
  const opts = { workspaceId: pr.workspaceId };
  let extra: Partial<MergeEtaAnswer> = {};
  try {
    const repositoryId = await repositoryIdFor(pr, creds);
    if (!repositoryId) return none('not_queued');
    const found = parseTrunkPullRequest(
      await resolvePullRequest(creds.token, { repositoryId, number: pr.number }, opts),
      pr.number
    );
    await clearReauthIfMarked(pr, creds);
    if (!found?.id) return none('not_queued');

    extra = {
      ...(found.queueState ? { queueState: found.queueState } : {}),
      ...(found.stateChangedAt ? { stateChangedAt: found.stateChangedAt } : {}),
    };
    const done =
      found.queueState === 'merged' ||
      found.queueState === 'failed' ||
      found.queueState === 'cancelled';
    if (found.isCurrentlySubmitted === false || found.queueState === null || done) {
      return none('not_queued', extra);
    }

    const eta = parseTrunkEstimate(await getQueueEntryEstimate(creds.token, found.id, opts));
    if (!eta) return none('no_estimate', extra);
    return { eta, ...extra, fetchedAt: new Date().toISOString() };
  } catch (err) {
    if (err instanceof TrunkRepositoryAccessError) {
      return none('no_access', { message: `This Trunk key cannot see ${pr.owner}/${pr.repo}` });
    }
    if (err instanceof TrunkAuthError) {
      if (!creds.reauthRequired) {
        await markTrunkReauthRequired(pr.workspaceId, creds.tokenFingerprint, err.message).catch(
          (e) => console.warn('[trunk] could not record the refused key:', e instanceof Error ? e.message : e)
        );
      }
      return none('reauth_required');
    }
    // The queue serves no estimates (ESTIMATE_NOT_ENABLED), or the repository
    // or PR is not one Trunk knows.
    if (err instanceof TrunkNotFoundError) {
      return none(err.code === 'ESTIMATE_NOT_ENABLED' ? 'no_estimate' : 'not_queued', extra);
    }
    // PR_NOT_IN_ACTIVE_STATE: the entry concluded between the two reads.
    if (err instanceof TrunkRequestError && err.status === 409) return none('not_queued', extra);
    console.warn(
      `[trunk] merge ETA for ${pr.owner}/${pr.repo}#${pr.number} failed:`,
      err instanceof Error ? err.message : err
    );
    return none('unavailable', extra);
  }
}

async function clearReauthIfMarked(pr: MergeEtaPr, creds: Credentials): Promise<void> {
  if (!creds.reauthRequired) return;
  await clearTrunkReauth(pr.workspaceId, creds.tokenFingerprint).catch((e) =>
    console.warn('[trunk] could not clear the reconnect marker:', e instanceof Error ? e.message : e)
  );
}

/** Drop cached answers for a workspace, after its key changes. */
export function clearMergeEtaCache(workspaceId?: string): void {
  if (!workspaceId) {
    answers.clear();
    repositoryIds.clear();
    repositoryInflight.clear();
    clearTrunkPause();
    return;
  }
  const prefix = `${workspaceId}:`;
  for (const key of answers.keys()) {
    if (key.startsWith(prefix)) answers.delete(key);
  }
}
