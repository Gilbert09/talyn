import { describe, expect, it } from 'vitest';
import { branchSlugFromSuggestion, branchSlugFromTitle, WORKBENCH_BRANCH_SLUG_MAX } from '../../../shared/src/workbench';
import { WORKBENCH_BRANCH_PROMPT_FILES_MAX, workbenchBranchPrompt } from '../../../shared/src/workbenchBranchName';
import { isValidBranchName, renameBranch } from '../../../shared/src/workbenchGit';

describe('branchSlugFromSuggestion', () => {
  it.each([
    ['a plain slug', 'fix-login-redirect', 'fix-login-redirect'],
    ['a trailing newline', 'fix-login-redirect\n', 'fix-login-redirect'],
    ['CRLF at the end', 'fix-login-redirect\r\n', 'fix-login-redirect'],
    ['surrounding whitespace', '   add-dark-mode   ', 'add-dark-mode'],
    ['double quotes', '"add-dark-mode"', 'add-dark-mode'],
    ['curly quotes', '“add-dark-mode”', 'add-dark-mode'],
    ['single quotes', "'add-dark-mode'", 'add-dark-mode'],
    ['backticks', '`add-dark-mode`', 'add-dark-mode'],
    ['triple backticks on one line', '```add-dark-mode```', 'add-dark-mode'],
    ['markdown bold', '**add-dark-mode**', 'add-dark-mode'],
    ['upper case', 'Add-Dark-Mode', 'add-dark-mode'],
    ['spaces between words', 'add dark mode', 'add-dark-mode'],
    ['underscores', 'add_dark_mode', 'add-dark-mode'],
    ['repeated hyphens', 'add--dark---mode', 'add-dark-mode'],
    ['edge hyphens', '-add-dark-mode-', 'add-dark-mode'],
    ['a user prefix', 'tom/add-dark-mode', 'add-dark-mode'],
    ['a feature prefix', 'feature/add-dark-mode', 'add-dark-mode'],
    ['a refs/heads prefix', 'refs/heads/feat/add-dark-mode', 'add-dark-mode'],
    ['a branch label', 'Branch name: add-dark-mode', 'add-dark-mode'],
    ['a slug label', 'slug: add-dark-mode', 'add-dark-mode'],
    ['a git command', 'git checkout -b fix/add-dark-mode', 'add-dark-mode'],
    ['a switch command', 'git switch -c add-dark-mode', 'add-dark-mode'],
    ['an apostrophe', "don't-crash-on-empty-cache", 'dont-crash-on-empty-cache'],
    ['diacritics folded', 'café-menü-fix', 'cafe-menu-fix'],
    ['digits kept', 'bump-react-19', 'bump-react-19'],
    ['an issue key', 'eng-123-fix-billing', 'eng-123-fix-billing'],
    ['too many words cut to six', 'one-two-three-four-five-six-seven-eight', 'one-two-three-four-five-six'],
    ['a trailing full stop', 'add-dark-mode.', 'add-dark-mode'],
  ])('reads %s', (_label, raw, expected) => {
    const slug = branchSlugFromSuggestion(raw);
    expect(slug).toBe(expected);
    expect(isValidBranchName(`tom/${slug}`)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['only whitespace', '   \n  '],
    ['only quotes', '""'],
    ['only punctuation', '!!! ... ---'],
    ['only digits', '12345'],
    ['a script with no ASCII form', '修复登录重定向'],
    ['emoji only', '🚀🔥'],
    ['two lines', 'add-dark-mode\nThis adds a dark mode'],
    ['an explanation after a blank line', 'add-dark-mode\n\nI chose this because'],
    ['a sentence of prose', 'I think a good name for this branch would be something like the following words here'],
    ['a reply far too long', `fix-${'a'.repeat(120)}`],
  ])('refuses %s', (_label, raw) => {
    expect(branchSlugFromSuggestion(raw as string | null | undefined)).toBeNull();
  });

  it('keeps the slug within the length cap, at a word boundary', () => {
    const slug = branchSlugFromSuggestion('refactor-workbench-provisioning-flow-multiple-hosts')!;
    expect(slug.length).toBeLessThanOrEqual(WORKBENCH_BRANCH_SLUG_MAX);
    expect(slug).toBe('refactor-workbench-provisioning-flow');
  });

  it('hard-cuts one very long word', () => {
    expect(branchSlugFromSuggestion('x'.repeat(60))).toBe('x'.repeat(WORKBENCH_BRANCH_SLUG_MAX));
  });

  it('keeps unicode letters that fold to ASCII and drops the rest', () => {
    expect(branchSlugFromSuggestion('fix-ñandú-修复')).toBe('fix-nandu');
  });
});

describe('branchSlugFromTitle', () => {
  it.each([
    ['a plain title', 'Fix webhook retry when Stripe returns 409', 'fix-webhook-retry-stripe-returns-409'],
    ['a conventional prefix with a scope', 'feat(billing): add seat counts to the team page', 'add-seat-counts-team-page'],
    ['a conventional prefix', 'fix: Don\'t crash when the cache is empty', 'dont-crash-cache-empty'],
    ['a breaking-change prefix', 'refactor!: split the turn loop', 'split-turn-loop'],
    ['a scoped breaking-change prefix', 'chore(deps)!: drop Node 18', 'drop-node-18'],
    ['an issue key first', 'ENG-123: Fix billing export', 'eng-123-fix-billing-export'],
    ['filler words', 'Please look at why the sidebar is too wide', 'sidebar-too-wide'],
    ['backticks', 'Rename `user_id` to `account_id`', 'rename-user-id-account-id'],
    ['quotes round it', '"Add dark mode"', 'add-dark-mode'],
    ['a body after the title', 'Add dark mode\n\nThis adds a dark mode toggle.', 'add-dark-mode'],
    ['a long title, cut at a word', 'Refactor the workbench provisioning flow to support multiple fleet hosts', 'refactor-workbench-provisioning-flow'],
    ['diacritics folded', 'Corrige le menü du café', 'corrige-le-menu-du-cafe'],
  ])('reads %s', (_label, raw, expected) => {
    const slug = branchSlugFromTitle(raw);
    expect(slug).toBe(expected);
    expect(slug!.length).toBeLessThanOrEqual(WORKBENCH_BRANCH_SLUG_MAX);
    expect(isValidBranchName(`tom/${slug}`)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['only a prefix', 'feat:'],
    ['only filler words', 'please look at this'],
    ['only digits', '2026 10 28'],
    ['a script with no ASCII form', '修复登录重定向'],
  ])('refuses %s', (_label, raw) => {
    expect(branchSlugFromTitle(raw as string | null | undefined)).toBeNull();
  });
});

describe('workbenchBranchPrompt', () => {
  it('asks for one hyphenated line and carries all three inputs', () => {
    const prompt = workbenchBranchPrompt({
      firstMessage: '  look at the login page  ',
      changedFiles: ['src/auth/redirect.ts', 'src/auth/redirect.test.ts'],
      finalMessage: 'I fixed the redirect loop after login.',
    });
    expect(prompt).toMatch(/2 to 6 lowercase words joined by hyphens/);
    expect(prompt).toMatch(/Do not add a prefix/);
    expect(prompt).toContain('look at the login page');
    expect(prompt).toContain('src/auth/redirect.ts\nsrc/auth/redirect.test.ts');
    expect(prompt).toContain('I fixed the redirect loop after login.');
  });

  it('says (none) for missing parts', () => {
    const prompt = workbenchBranchPrompt({ firstMessage: ' ', changedFiles: [], finalMessage: '' });
    expect(prompt.match(/\(none\)/g)).toHaveLength(3);
  });

  it('caps the file list and the long texts', () => {
    const files = Array.from({ length: WORKBENCH_BRANCH_PROMPT_FILES_MAX + 7 }, (_, i) => `f${i}.ts`);
    const prompt = workbenchBranchPrompt({ firstMessage: 'x'.repeat(10_000), changedFiles: files, finalMessage: 'y'.repeat(10_000) });
    expect(prompt).toContain(`f${WORKBENCH_BRANCH_PROMPT_FILES_MAX - 1}.ts`);
    expect(prompt).not.toContain(`f${WORKBENCH_BRANCH_PROMPT_FILES_MAX}.ts`);
    expect(prompt).toContain('(and 7 more)');
    expect(prompt.length).toBeLessThan(5_000);
  });
});

describe('renameBranch', () => {
  it.each([
    [['new'], ['git', 'branch', '-m', 'new']],
    [['new', 'old'], ['git', 'branch', '-m', 'old', 'new']],
  ] as const)('%j', (args, argv) => {
    expect(renameBranch(...(args as unknown as [string, string?])).argv).toEqual(argv);
  });
});
