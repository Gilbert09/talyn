import { describe, expect, it } from 'vitest';
import {
  WORKBENCH_CITY_NAMES,
  WORKBENCH_TASK_NAME_MAX,
  workbenchNameFromTask,
} from '../../../shared/src/workbench';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

describe('workbenchNameFromTask', () => {
  it.each([
    ['plain words', 'Refactor billing webhook retries', 'refactor-billing-webhook'],
    ['keeps fix as a verb', 'Fix the login redirect bug', 'fix-login-redirect'],
    ['keeps add as a verb', 'Add dark mode to settings', 'add-dark-mode'],
    ['drops politeness and pronouns', 'Can you please update our README', 'update-readme'],
    ['drops filler verbs', 'please make the sidebar wider', 'sidebar-wider'],
    ['stops after three words', 'rename user model fields everywhere', 'rename-user-model'],
    ['two significant words', 'the onboarding flow', 'onboarding-flow'],
    ['one significant word', 'refactor', 'refactor'],
    ['punctuation between words', 'Fix: CSV export (crashes!) on Safari', 'fix-csv-export'],
    ['apostrophes join', "Don't crash when the cache's empty", 'dont-crash-caches'],
    ['version numbers split on the dot', 'Bump React to 19.1', 'bump-react-19'],
    ['digits kept', 'v2 API pagination', 'v2-api-pagination'],
    ['diacritics folded', 'Café menü überarbeiten', 'cafe-menu-uberarbeiten'],
    ['only the first line matters in practice', 'Fix flaky test\n\nIt fails on CI half the time', 'fix-flaky-test'],
    ['urls skipped', 'Look at https://github.com/acme/app/issues/12 and fix it', 'look-fix'],
    ['markdown and slashes', '`/review` the **auth** module', 'review-auth-module'],
    ['leading and trailing whitespace', '   tidy   imports   ', 'tidy-imports'],
    ['mixed scripts keep the ASCII words', '修复 login 页面 bug', 'login-bug'],
  ])('%s', (_label, text, expected) => {
    expect(workbenchNameFromTask(text, new Set())).toBe(expected);
  });

  it.each([
    ['a long third word is left off', 'fix login internationalisation', 'fix-login'],
    ['a long second word is left off', 'add internationalisationsupport', 'add'],
  ])('%s', (_label, text, expected) => {
    expect(workbenchNameFromTask(text, new Set())).toBe(expected);
  });

  it('cuts a single word longer than the limit', () => {
    const name = workbenchNameFromTask('supercalifragilisticexpialidocious', new Set());
    expect(name).toBe('supercalifragilisticexpi');
    expect(name).toHaveLength(WORKBENCH_TASK_NAME_MAX);
  });

  it.each([
    ['very long text', 'Migrate the entire authentication subsystem to the new identity provider and remove legacy sessions'],
    ['many short words', 'a b c d e f g h i j k l m n o p'],
    ['long words', 'internationalisation localisation accessibility'],
  ])('stays within the limit for %s', (_label, text) => {
    const name = workbenchNameFromTask(text, new Set());
    expect(name.length).toBeLessThanOrEqual(WORKBENCH_TASK_NAME_MAX);
    expect(name).toMatch(NAME_PATTERN);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   \n\t '],
    ['only stop words', 'can you please do this for me'],
    ['only punctuation', '?!... --- ***'],
    ['only non-latin', '修复登录页面'],
    ['only emoji', '🚀🔥'],
    ['only a url', 'https://example.com/path'],
  ])('falls back to a city for %s', (_label, text) => {
    expect(WORKBENCH_CITY_NAMES).toContain(workbenchNameFromTask(text, new Set(), () => 0));
  });

  it('the city fallback respects taken names', () => {
    const first = WORKBENCH_CITY_NAMES[0];
    expect(workbenchNameFromTask('', new Set([first]), () => 0)).toBe(WORKBENCH_CITY_NAMES[1]);
  });

  it.each([
    ['free', [], 'fix-login'],
    ['taken once', ['fix-login'], 'fix-login-2'],
    ['taken twice', ['fix-login', 'fix-login-2'], 'fix-login-3'],
    ['fills the lowest gap', ['fix-login', 'fix-login-3'], 'fix-login-2'],
    ['case and whitespace insensitive', [' FIX-LOGIN '], 'fix-login-2'],
    ['an unrelated name does not count', ['fix-logout'], 'fix-login'],
  ])('collision: %s', (_label, taken, expected) => {
    expect(workbenchNameFromTask('Fix login', new Set(taken))).toBe(expected);
  });

  it('accepts any iterable of taken names', () => {
    expect(workbenchNameFromTask('Fix login', ['fix-login'])).toBe('fix-login-2');
  });

  it('every name is a valid workbench name and branch segment', () => {
    for (const text of ['Fix: it', 'Ünïcödé wörds', '__init__ cleanup', '-leading dash', '123 456']) {
      expect(workbenchNameFromTask(text, new Set())).toMatch(NAME_PATTERN);
    }
  });
});
