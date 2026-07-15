// Does a repo's base branch REQUIRE signed commits?
//
// PostHog's `master` enforces a "require signed commits" ruleset: a PR whose
// branch has any unsigned commit makes the App's merge attempt 403. Most repos
// don't enforce this, so the merge queue asks here ONCE (cached ~1h) whether a
// given base branch requires signatures before it bothers looking at per-commit
// signature state. See docs — the merge-queue signing gate is the only caller.

import { githubService } from './github.js';

const CACHE_TTL_MS = 60 * 60_000; // 1h — ruleset/protection config changes rarely.

interface CacheEntry {
  required: boolean;
  at: number;
  /** Learned from an observed 403 (see {@link markSigningRequired}) — never
   *  re-probed back to false, since a probe can miss a ruleset the App can't read. */
  sticky?: boolean;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(workspaceId: string, owner: string, repo: string, baseBranch: string): string {
  return `${workspaceId}:${owner.toLowerCase()}/${repo.toLowerCase()}:${baseBranch}`;
}

// ---------- GraphQL probe ----------

const SIGNING_QUERY = `query RepoSigning($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    defaultBranchRef { name }
    branchProtectionRules(first: 100) {
      nodes { pattern requiresCommitSignatures }
    }
    rulesets(first: 50, includeParents: true) {
      nodes {
        enforcement
        target
        conditions { refName { include exclude } }
        rules(first: 50) { nodes { type } }
      }
    }
  }
  rateLimit { limit cost remaining resetAt }
}`;

interface SigningResponse {
  repository: {
    defaultBranchRef: { name: string } | null;
    branchProtectionRules: {
      nodes: Array<{ pattern: string; requiresCommitSignatures: boolean }>;
    };
    rulesets: {
      nodes: Array<{
        enforcement: string;
        target: string;
        conditions: { refName: { include: string[]; exclude: string[] } | null } | null;
        rules: { nodes: Array<{ type: string }> };
      }>;
    } | null;
  } | null;
}

/**
 * Match one ruleset refName condition token against a base branch. Handles the
 * GitHub special tokens (`~ALL`, `~DEFAULT_BRANCH`), fully-qualified
 * `refs/heads/<glob>` patterns, and bare globs. `*` is the only wildcard.
 */
function refMatches(token: string, baseBranch: string, defaultBranch: string | null): boolean {
  if (token === '~ALL') return true;
  if (token === '~DEFAULT_BRANCH') return !!defaultBranch && baseBranch === defaultBranch;
  const pattern = token.startsWith('refs/heads/') ? token.slice('refs/heads/'.length) : token;
  return globMatch(pattern, baseBranch);
}

/** Minimal fnmatch: `*` matches any run of chars, everything else is literal. */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp(
    '^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'
  );
  return re.test(value);
}

/** Classic branch-protection glob patterns match a bare branch name (no refs/heads/ prefix). */
function protectionPatternMatches(pattern: string, baseBranch: string): boolean {
  return globMatch(pattern, baseBranch);
}

async function probe(
  workspaceId: string,
  owner: string,
  repo: string,
  baseBranch: string
): Promise<boolean> {
  const data = await githubService.executeGraphql<SigningResponse>(workspaceId, SIGNING_QUERY, {
    owner,
    repo,
  });
  const repository = data.repository;
  if (!repository) return false;
  const defaultBranch = repository.defaultBranchRef?.name ?? null;

  // Classic branch protection.
  for (const rule of repository.branchProtectionRules.nodes) {
    if (rule.requiresCommitSignatures && protectionPatternMatches(rule.pattern, baseBranch)) {
      return true;
    }
  }

  // Rulesets (how PostHog enforces it).
  for (const rs of repository.rulesets?.nodes ?? []) {
    if (rs.enforcement !== 'ACTIVE') continue;
    if (rs.target !== 'BRANCH') continue;
    const hasSignatureRule = rs.rules.nodes.some((r) => r.type === 'REQUIRED_SIGNATURES');
    if (!hasSignatureRule) continue;
    const refName = rs.conditions?.refName;
    // No conditions → applies to all branches.
    const includes = refName?.include ?? ['~ALL'];
    const excludes = refName?.exclude ?? [];
    const included = includes.some((t) => refMatches(t, baseBranch, defaultBranch));
    const excluded = excludes.some((t) => refMatches(t, baseBranch, defaultBranch));
    if (included && !excluded) return true;
  }
  return false;
}

/**
 * Whether `baseBranch` on `owner/repo` requires signed commits. Cached ~1h.
 * Degrades to `false` on a probe error (e.g. the App can't read rulesets) — the
 * merge queue's 403 safety net + {@link markSigningRequired} still catch it.
 */
export async function requiresSignedCommits(
  workspaceId: string,
  owner: string,
  repo: string,
  baseBranch: string
): Promise<boolean> {
  if (!baseBranch) return false;
  const key = cacheKey(workspaceId, owner, repo, baseBranch);
  const cached = cache.get(key);
  if (cached && (cached.sticky || Date.now() - cached.at < CACHE_TTL_MS)) {
    return cached.required;
  }
  try {
    const required = await probe(workspaceId, owner, repo, baseBranch);
    cache.set(key, { required, at: Date.now() });
    return required;
  } catch {
    // Probe failed (permissions / transient) — don't proactively re-sign; the
    // 403 net handles it. Cache a short-lived false so we retry soon.
    cache.set(key, { required: false, at: Date.now() - CACHE_TTL_MS + 5 * 60_000 });
    return false;
  }
}

/**
 * Record — from an observed unsigned-commit 403 — that this base branch requires
 * signed commits, so every subsequent PR is handled proactively even if the
 * config probe couldn't see the rule. Sticky: never re-probed back to false.
 */
export function markSigningRequired(
  workspaceId: string,
  owner: string,
  repo: string,
  baseBranch: string
): void {
  if (!baseBranch) return;
  cache.set(cacheKey(workspaceId, owner, repo, baseBranch), {
    required: true,
    at: Date.now(),
    sticky: true,
  });
}

/** Test helper — clear the signing-requirement cache between cases. */
export function _resetRepoSigningCache(): void {
  cache.clear();
}
