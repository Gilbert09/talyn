import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { githubService } from '../services/github.js';
import {
  requiresSignedCommits,
  markSigningRequired,
  _resetRepoSigningCache,
} from '../services/repoSigning.js';

// Shapes the RepoSigning GraphQL probe returns.
function response(opts: {
  defaultBranch?: string;
  protection?: Array<{ pattern: string; requiresCommitSignatures: boolean }>;
  rulesets?: Array<{
    enforcement?: string;
    target?: string;
    include?: string[];
    exclude?: string[];
    ruleTypes?: string[];
  }>;
}) {
  return {
    repository: {
      defaultBranchRef: opts.defaultBranch ? { name: opts.defaultBranch } : null,
      branchProtectionRules: { nodes: opts.protection ?? [] },
      rulesets: {
        nodes: (opts.rulesets ?? []).map((r) => ({
          enforcement: r.enforcement ?? 'ACTIVE',
          target: r.target ?? 'BRANCH',
          conditions: { refName: { include: r.include ?? ['~ALL'], exclude: r.exclude ?? [] } },
          rules: { nodes: (r.ruleTypes ?? []).map((type) => ({ type })) },
        })),
      },
    },
  };
}

describe('repoSigning.requiresSignedCommits', () => {
  let gql: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetRepoSigningCache();
    gql = vi.spyOn(githubService, 'executeGraphql');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is true for an ACTIVE ruleset with REQUIRED_SIGNATURES that includes the base branch', async () => {
    gql.mockResolvedValue(
      response({ rulesets: [{ include: ['refs/heads/master'], ruleTypes: ['REQUIRED_SIGNATURES'] }] })
    );
    expect(await requiresSignedCommits('ws', 'PostHog', 'posthog', 'master')).toBe(true);
  });

  it('matches ~ALL and ~DEFAULT_BRANCH ref conditions', async () => {
    gql.mockResolvedValue(response({ rulesets: [{ include: ['~ALL'], ruleTypes: ['REQUIRED_SIGNATURES'] }] }));
    expect(await requiresSignedCommits('ws', 'o', 'r', 'anything')).toBe(true);

    _resetRepoSigningCache();
    gql.mockResolvedValue(
      response({
        defaultBranch: 'main',
        rulesets: [{ include: ['~DEFAULT_BRANCH'], ruleTypes: ['REQUIRED_SIGNATURES'] }],
      })
    );
    expect(await requiresSignedCommits('ws', 'o', 'r', 'main')).toBe(true);
    _resetRepoSigningCache();
    expect(await requiresSignedCommits('ws', 'o', 'r', 'feature')).toBe(false);
  });

  it('is false when the base is excluded, the ruleset is disabled, or has no signature rule', async () => {
    gql.mockResolvedValue(
      response({
        rulesets: [
          { include: ['~ALL'], exclude: ['refs/heads/master'], ruleTypes: ['REQUIRED_SIGNATURES'] },
        ],
      })
    );
    expect(await requiresSignedCommits('ws', 'o', 'r', 'master')).toBe(false);

    _resetRepoSigningCache();
    gql.mockResolvedValue(
      response({ rulesets: [{ enforcement: 'DISABLED', ruleTypes: ['REQUIRED_SIGNATURES'] }] })
    );
    expect(await requiresSignedCommits('ws', 'o', 'r', 'master')).toBe(false);

    _resetRepoSigningCache();
    gql.mockResolvedValue(response({ rulesets: [{ ruleTypes: ['PULL_REQUEST'] }] }));
    expect(await requiresSignedCommits('ws', 'o', 'r', 'master')).toBe(false);
  });

  it('honours classic branch-protection requiresCommitSignatures (with globs)', async () => {
    gql.mockResolvedValue(response({ protection: [{ pattern: 'ma*', requiresCommitSignatures: true }] }));
    expect(await requiresSignedCommits('ws', 'o', 'r', 'master')).toBe(true);

    _resetRepoSigningCache();
    gql.mockResolvedValue(response({ protection: [{ pattern: 'release/*', requiresCommitSignatures: true }] }));
    expect(await requiresSignedCommits('ws', 'o', 'r', 'master')).toBe(false);
  });

  it('caches the probe — a second call does not re-query', async () => {
    gql.mockResolvedValue(response({ rulesets: [{ ruleTypes: ['REQUIRED_SIGNATURES'] }] }));
    expect(await requiresSignedCommits('ws', 'o', 'r', 'master')).toBe(true);
    expect(await requiresSignedCommits('ws', 'o', 'r', 'master')).toBe(true);
    expect(gql).toHaveBeenCalledTimes(1);
  });

  it('degrades to false on a probe error (and the 403 net + markSigningRequired cover it)', async () => {
    gql.mockRejectedValue(new Error('Resource not accessible by integration'));
    expect(await requiresSignedCommits('ws', 'o', 'r', 'master')).toBe(false);
  });

  it('markSigningRequired makes a base sticky-true without any probe', async () => {
    markSigningRequired('ws', 'o', 'r', 'master');
    expect(await requiresSignedCommits('ws', 'o', 'r', 'master')).toBe(true);
    expect(gql).not.toHaveBeenCalled(); // sticky — never probes
  });
});
