// GitHub native auto-merge — the merge queue's zero-latency merge primitive.
//
// Once a queue head is clean-but-awaiting-CI, arming auto-merge hands the
// merge moment to GitHub: it merges the instant the last requirement passes,
// with no Talyn polling, no rate-budget dependency, and no queue latency. We
// observe the result via the `pull_request closed` webhook.
//
// Everything rides `githubService.executeGraphql`, so debugBus HTTP
// recording, GraphQL budget capture, and the rate gate all apply for free.
// Peer of repoSigning.ts: the repo capability probe is cached (1h) with a
// sticky learn-from-failure downgrade.

import { githubService } from './github.js';
import type { MergeMethod } from './mergeQueue/types.js';

const CACHE_TTL_MS = 60 * 60 * 1000;

interface CapabilityEntry {
  at: number;
  autoMergeAllowed: boolean;
  methods: { merge: boolean; squash: boolean; rebase: boolean };
  /** Learned from a definitive arm refusal — outlives the TTL probe result. */
  stickyUnavailable?: boolean;
}

const capabilityCache = new Map<string, CapabilityEntry>();

function cacheKey(workspaceId: string, owner: string, repo: string): string {
  return `${workspaceId}|${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

/** Test hook. */
export function _resetAutoMergeCache(): void {
  capabilityCache.clear();
}

const CAPABILITY_QUERY = `query RepoAutoMerge($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    autoMergeAllowed
    mergeCommitAllowed
    squashMergeAllowed
    rebaseMergeAllowed
  }
  rateLimit { limit cost remaining resetAt }
}`;

/**
 * Can auto-merge be armed on this repo with this merge method? 'unknown' on
 * probe failure — callers treat it as unavailable this evaluation and retry
 * later (never block the direct-merge path on this answer).
 */
export async function getAutoMergeCapability(
  workspaceId: string,
  owner: string,
  repo: string,
  method: MergeMethod
): Promise<'available' | 'unavailable' | 'unknown'> {
  const key = cacheKey(workspaceId, owner, repo);
  let entry = capabilityCache.get(key);
  if (entry?.stickyUnavailable) return 'unavailable';
  if (!entry || Date.now() - entry.at > CACHE_TTL_MS) {
    try {
      const data = await githubService.executeGraphql<{
        repository: {
          autoMergeAllowed: boolean;
          mergeCommitAllowed: boolean;
          squashMergeAllowed: boolean;
          rebaseMergeAllowed: boolean;
        } | null;
      }>(workspaceId, CAPABILITY_QUERY, { owner, repo });
      if (!data.repository) return 'unknown';
      entry = {
        at: Date.now(),
        autoMergeAllowed: data.repository.autoMergeAllowed,
        methods: {
          merge: data.repository.mergeCommitAllowed,
          squash: data.repository.squashMergeAllowed,
          rebase: data.repository.rebaseMergeAllowed,
        },
      };
      capabilityCache.set(key, entry);
    } catch (err) {
      console.warn(
        `[githubAutoMerge] capability probe failed for ${owner}/${repo}:`,
        err instanceof Error ? err.message : err
      );
      return 'unknown';
    }
  }
  return entry.autoMergeAllowed && entry.methods[method] ? 'available' : 'unavailable';
}

/**
 * Learn from a definitive arm refusal ("auto merge is not allowed", method
 * rejected): stop trying to arm on this repo until the process restarts. The
 * direct-merge path is unaffected.
 */
export function markAutoMergeUnavailable(workspaceId: string, owner: string, repo: string): void {
  const key = cacheKey(workspaceId, owner, repo);
  const entry = capabilityCache.get(key);
  capabilityCache.set(key, {
    at: Date.now(),
    autoMergeAllowed: false,
    methods: entry?.methods ?? { merge: false, squash: false, rebase: false },
    stickyUnavailable: true,
  });
}

const ENABLE_MUTATION = `mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!, $expectedHeadOid: GitObjectID) {
  enablePullRequestAutoMerge(input: {
    pullRequestId: $pullRequestId,
    mergeMethod: $mergeMethod,
    expectedHeadOid: $expectedHeadOid
  }) {
    pullRequest { autoMergeRequest { enabledAt enabledBy { login } } }
  }
}`;

const DISABLE_MUTATION = `mutation DisableAutoMerge($pullRequestId: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
    pullRequest { number }
  }
}`;

const READY_FOR_REVIEW_MUTATION = `mutation MarkReady($pullRequestId: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
    pullRequest { isDraft }
  }
}`;

/**
 * Take a draft PR out of draft so the queue can merge it — GitHub 405s a draft
 * merge. GraphQL-only (there's no REST equivalent). Best-effort + idempotent:
 * a PR that's already ready ("not a draft") reports success, so a stale-cache
 * false positive is harmless. `false` only on a real failure (permissions,
 * network) — the caller keeps the PR queued and decide()'s draft block still
 * surfaces the manual action.
 */
export async function markReadyForReview(opts: {
  workspaceId: string;
  owner: string;
  repo: string;
  nodeId: string;
}): Promise<boolean> {
  try {
    await githubService.executeGraphql(opts.workspaceId, READY_FOR_REVIEW_MUTATION, {
      pullRequestId: opts.nodeId,
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Already ready for review / not a draft → nothing to do; treat as done.
    if (/not a draft|already.*ready|ready for review/i.test(message)) return true;
    console.warn(
      `[githubAutoMerge] mark-ready-for-review failed for ${opts.owner}/${opts.repo}:`,
      message
    );
    return false;
  }
}

export type ArmResult =
  | { armed: true }
  /**
   * GitHub refuses to arm a PR that is already immediately mergeable
   * ("Pull request is in clean status") — nothing to wait for. The caller
   * falls back to the direct merge, which is exactly right.
   */
  | { armed: false; reason: 'clean_status' }
  /** expectedHeadOid mismatch — a push landed mid-arm; re-evaluate. */
  | { armed: false; reason: 'head_mismatch' }
  /** Repo/method definitively refuses auto-merge — recorded sticky. */
  | { armed: false; reason: 'not_allowed'; message: string }
  | { armed: false; reason: 'error'; message: string };

const METHOD_MAP: Record<MergeMethod, string> = {
  merge: 'MERGE',
  squash: 'SQUASH',
  rebase: 'REBASE',
};

/**
 * Arm GitHub auto-merge on the PR. `expectedHeadOid` is the load-bearing
 * safety feature: arming races a concurrent push, and the OID pin makes
 * GitHub refuse (head_mismatch) instead of arming the wrong commit.
 */
export async function enableAutoMerge(opts: {
  workspaceId: string;
  owner: string;
  repo: string;
  nodeId: string;
  mergeMethod: MergeMethod;
  expectedHeadOid: string;
}): Promise<ArmResult> {
  try {
    await githubService.executeGraphql(opts.workspaceId, ENABLE_MUTATION, {
      owner: opts.owner,
      pullRequestId: opts.nodeId,
      mergeMethod: METHOD_MAP[opts.mergeMethod],
      expectedHeadOid: opts.expectedHeadOid,
    });
    return { armed: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/clean status/i.test(message)) return { armed: false, reason: 'clean_status' };
    if (/head|oid/i.test(message) && /match|expected|changed/i.test(message)) {
      return { armed: false, reason: 'head_mismatch' };
    }
    if (/auto[- ]?merge is not allowed|not allowed|not enabled/i.test(message)) {
      markAutoMergeUnavailable(opts.workspaceId, opts.owner, opts.repo);
      return { armed: false, reason: 'not_allowed', message };
    }
    return { armed: false, reason: 'error', message };
  }
}

/** Disarm a Talyn-armed auto-merge. Best-effort; idempotent on GitHub's side
 *  (disabling an un-armed PR errors, which we treat as already-disarmed). */
export async function disableAutoMerge(opts: {
  workspaceId: string;
  owner: string;
  repo: string;
  nodeId: string;
}): Promise<boolean> {
  try {
    await githubService.executeGraphql(opts.workspaceId, DISABLE_MUTATION, {
      owner: opts.owner,
      pullRequestId: opts.nodeId,
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // "not in auto-merge state" / already merged → nothing armed; that's done.
    if (/auto[- ]?merge|not.*enabled|already/i.test(message)) return true;
    console.warn(
      `[githubAutoMerge] disarm failed for ${opts.owner}/${opts.repo}:`,
      message
    );
    return false;
  }
}

/**
 * Classify who armed auto-merge from the summary's `autoMergeBy` login:
 * the App's bot login (`<slug>[bot]`) is Talyn; anything else is the user.
 * We never disarm what we didn't arm.
 */
export function classifyAutoMergeActor(login: string | null | undefined): 'talyn' | 'user' | null {
  if (!login) return null;
  const slug = process.env.GITHUB_APP_SLUG || '';
  return slug && login.toLowerCase() === `${slug.toLowerCase()}[bot]` ? 'talyn' : 'user';
}
