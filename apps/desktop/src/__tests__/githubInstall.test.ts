import {
  installedAccounts,
  isOwnerCovered,
  uncoveredOwners,
  formatOwnerList,
} from '../renderer/lib/githubInstall';
import type { GitHubInstallation } from '../renderer/lib/api';

function install(
  accountLogin: string,
  suspended = false
): GitHubInstallation {
  return { accountLogin, accountType: 'Organization', suspended, repositorySelection: 'all' };
}

describe('githubInstall helpers', () => {
  describe('installedAccounts', () => {
    it('lowercases logins and drops suspended installs', () => {
      const set = installedAccounts([install('Acme'), install('PostHog', true)]);
      expect(set.has('acme')).toBe(true);
      expect(set.has('posthog')).toBe(false);
    });
  });

  describe('isOwnerCovered', () => {
    it.each([
      ['acme', true],
      ['ACME', true], // case-insensitive
      ['posthog', false], // suspended
      ['nobody', false], // not installed
    ])('owner %s → %s', (owner, expected) => {
      const installs = [install('acme'), install('posthog', true)];
      expect(isOwnerCovered(owner, installs)).toBe(expected);
    });
  });

  describe('uncoveredOwners', () => {
    it('returns distinct, sorted, case-insensitive uncovered owners', () => {
      const installs = [install('acme')];
      const owners = ['acme', 'Posthog', 'posthog', 'Zeta', 'acme'];
      expect(uncoveredOwners(owners, installs)).toEqual(['Posthog', 'Zeta']);
    });

    it('counts a suspended install as uncovered', () => {
      expect(uncoveredOwners(['acme'], [install('acme', true)])).toEqual(['acme']);
    });

    it('returns [] when every owner is covered', () => {
      expect(uncoveredOwners(['acme'], [install('acme')])).toEqual([]);
    });
  });

  describe('formatOwnerList', () => {
    it.each([
      [['a'], '@a'],
      [['a', 'b'], '@a and @b'],
      [['a', 'b', 'c'], '@a, @b and @c'],
    ])('%j → %s', (owners, expected) => {
      expect(formatOwnerList(owners)).toBe(expected);
    });
  });
});
