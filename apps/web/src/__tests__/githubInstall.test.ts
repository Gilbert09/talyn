import { describe, it, expect } from 'vitest';
import { isPollingOnlyOwner, parseRepoInput } from '../lib/githubInstall';
import type { GitHubInstallation, GitHubOwnerCoverage } from '../lib/api';

function install(accountLogin: string, suspended = false): GitHubInstallation {
  return { accountLogin, accountType: 'Organization', suspended, repositorySelection: 'all' };
}

describe('githubInstall polling helpers', () => {
  describe('isPollingOnlyOwner', () => {
    const coverage: GitHubOwnerCoverage[] = [
      { owner: 'ClickHouse', state: 'not_installed' },
      { owner: 'Paused', state: 'suspended' },
      { owner: 'PostHog', state: 'sso_required', ssoUrl: null },
      { owner: 'Hidden', state: 'not_accessible' },
      { owner: 'Mystery', state: 'unknown' },
    ];
    it.each<[string, GitHubInstallation[] | null, GitHubOwnerCoverage[] | null, boolean]>([
      ['ClickHouse', [], coverage, true],
      ['clickhouse', [], coverage, true], // case-insensitive
      ['Paused', [], coverage, true], // suspended: no webhooks
      ['PostHog', [], coverage, false], // installed, sign-in problem
      ['Hidden', [], coverage, false], // installed, cannot reach
      ['Mystery', [], coverage, false], // never guess
      ['Absent', [], coverage, false], // no diagnosis for this owner
      ['ClickHouse', null, coverage, false], // installations not loaded
      ['ClickHouse', [], null, false], // diagnosis not loaded or failed
      ['ClickHouse', [install('clickhouse')], coverage, false], // a stale diagnosis loses to a live install
    ])('%s → %s', (owner, installations, cov, expected) => {
      expect(isPollingOnlyOwner(owner, installations, cov)).toBe(expected);
    });
  });

  describe('parseRepoInput', () => {
    it.each([
      ['ClickHouse/ClickHouse', { owner: 'ClickHouse', repo: 'ClickHouse' }],
      ['  ClickHouse/ClickHouse  ', { owner: 'ClickHouse', repo: 'ClickHouse' }],
      ['ClickHouse/ClickHouse.git', { owner: 'ClickHouse', repo: 'ClickHouse' }],
      ['https://github.com/ClickHouse/ClickHouse', { owner: 'ClickHouse', repo: 'ClickHouse' }],
      ['github.com/ClickHouse/ClickHouse/', { owner: 'ClickHouse', repo: 'ClickHouse' }],
      ['https://www.github.com/a/b.c', { owner: 'a', repo: 'b.c' }],
      ['https://github.com/ClickHouse/ClickHouse/pull/120046', { owner: 'ClickHouse', repo: 'ClickHouse' }],
      ['https://github.com/a/b?tab=readme', { owner: 'a', repo: 'b' }],
      ['pos.thog/post-hog_1', { owner: 'pos.thog', repo: 'post-hog_1' }],
    ])('parses %s', (input, expected) => {
      expect(parseRepoInput(input)).toEqual(expected);
    });

    it.each([
      ['clickhouse'],
      [''],
      ['a/b/c'],
      ['https://gitlab.com/a/b'],
      ['https://github.com/a'],
      ['../b'],
      ['a/..'],
      ['a b/c'],
    ])('refuses %s', (input) => {
      expect(parseRepoInput(input)).toBeNull();
    });
  });
});
