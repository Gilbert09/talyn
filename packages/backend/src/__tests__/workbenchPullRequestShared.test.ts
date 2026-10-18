import { describe, expect, it } from 'vitest';
import {
  buildPrDraftArgv,
  buildPrDraftPrompt,
  commitAllSteps,
  commitsAheadSteps,
  DEFAULT_FLEET_CODEX_MODEL_ID,
  DEFAULT_FLEET_MODEL_ID,
  describePushFailure,
  parseCommitsAhead,
  parsePrDraft,
  PR_DRAFT_CLAUDE_TOOLS,
  prCommitMessage,
  pushHeadStep,
  shellQuote,
  toShellScript,
} from '@talyn/shared';

describe('parsePrDraft', () => {
  const json = '{"title":"feat: add it","body":"## Summary\\nAdds it.","commitMessage":"feat: wip"}';
  const expected = { title: 'feat: add it', body: '## Summary\nAdds it.', commitMessage: 'feat: wip' };

  it.each<[string, string]>([
    ['a bare object', json],
    ['a json fence', `Here is the draft:\n\`\`\`json\n${json}\n\`\`\`\nDone.`],
    ['a plain fence', `\`\`\`\n${json}\n\`\`\``],
    ['prose around a bare object', `I looked at the diff. ${json} Hope that helps.`],
    ['the last fence wins', `\`\`\`json\n{"title":"old","body":"x"}\n\`\`\`\nBetter:\n\`\`\`json\n${json}\n\`\`\``],
    ['the last object wins', `{"title":"old","body":"x"}\n${json}`],
    ['braces inside the body string', json.replace('Adds it.', 'Adds {it}.')],
    ['an earlier object with no title is skipped', `${json}\n{"note":"no title here"}`],
  ])('reads %s', (name, text) => {
    const result = parsePrDraft(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (name === 'braces inside the body string') expect(result.draft.body).toBe('## Summary\nAdds {it}.');
    else expect(result.draft).toEqual(expected);
  });

  it.each<[string, string, Partial<Record<'title' | 'body' | 'commitMessage', string>>]>([
    ['missing body and commit message default to empty', '{"title":"fix: x"}', { title: 'fix: x', body: '', commitMessage: '' }],
    ['a multi-line title collapses to one line', '{"title":"fix:\\n  x  y","body":""}', { title: 'fix: x y' }],
    ['non-string fields are dropped', '{"title":"fix: x","body":3,"commitMessage":null}', { body: '', commitMessage: '' }],
  ])('%s', (_name, text, fields) => {
    const result = parsePrDraft(text);
    expect(result.ok && result.draft).toMatchObject(fields);
  });

  it('caps the title at GitHub’s 256 characters', () => {
    const result = parsePrDraft(JSON.stringify({ title: 'x'.repeat(400), body: '' }));
    expect(result.ok && result.draft.title.length).toBe(256);
  });

  it.each([
    ['empty text', ''],
    ['prose only', 'I could not find any changes.'],
    ['a blank title', '{"title":"   ","body":"x"}'],
    ['a title that is not a string', '{"title":42,"body":"x"}'],
    ['broken JSON', '```json\n{"title": "x", \n```'],
    ['an array of strings', '["title", "x"]'],
  ])('refuses %s', (_name, text) => {
    expect(parsePrDraft(text)).toEqual({ ok: false, error: 'The agent did not answer with a title and description.' });
  });
});

describe('buildPrDraftPrompt', () => {
  it('names the branch and base, the read-only rule, the template paths and the JSON keys', () => {
    const prompt = buildPrDraftPrompt({ branch: 'oslo', baseBranch: 'develop' });
    for (const part of [
      '`oslo`',
      'merged into `develop`',
      'Only read.',
      'git diff origin/develop...HEAD',
      'git status',
      '.github/pull_request_template.md',
      '.github/PULL_REQUEST_TEMPLATE/',
      '"title"',
      '"body"',
      '"commitMessage"',
      '```json',
    ]) {
      expect(prompt).toContain(part);
    }
    expect(prompt).not.toContain('Extra instructions');
  });

  it.each([
    ['appended when set', 'Link the Linear ticket.', true],
    ['skipped when blank', '   ', false],
    ['skipped when null', null, false],
  ])('extra instructions are %s', (_name, extra, present) => {
    const prompt = buildPrDraftPrompt({ branch: 'b', baseBranch: 'main', extraInstructions: extra });
    expect(prompt.includes('Extra instructions for this pull request:')).toBe(present);
    if (present) expect(prompt.trimEnd().endsWith('Link the Linear ticket.')).toBe(true);
  });
});

describe('buildPrDraftArgv', () => {
  it('Claude: a fork of the chat session, the fast model, read-only tools, prompt last', () => {
    const argv = buildPrDraftArgv({ agent: 'claude', prompt: '- draft it', resumeSessionId: 'sess-1' });
    expect(argv[0]).toBe('claude');
    expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2)).toEqual(['--model', DEFAULT_FLEET_MODEL_ID]);
    expect(argv.slice(argv.indexOf('--permission-mode'), argv.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'dontAsk']);
    expect(argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 3)).toEqual(['--resume', 'sess-1', '--fork-session']);
    const tools = argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--'));
    expect(tools).toEqual([...PR_DRAFT_CLAUDE_TOOLS]);
    expect(tools.some((t) => /Edit|Write|git (commit|push)/.test(t))).toBe(false);
    expect(argv.slice(-2)).toEqual(['--', '- draft it']);
  });

  it.each([[undefined], [null], ['']])('Claude with no session (%s) runs fresh', (session) => {
    const argv = buildPrDraftArgv({ agent: 'claude', prompt: 'p', resumeSessionId: session });
    expect(argv).not.toContain('--resume');
    expect(argv).not.toContain('--fork-session');
  });

  it.each([
    ['the chat model', 'gpt-5.6-sol', 'gpt-5.6-sol'],
    ['the default when the chat has none', null, DEFAULT_FLEET_CODEX_MODEL_ID],
  ])('Codex: read-only, never resumed, with %s', (_name, model, expected) => {
    const argv = buildPrDraftArgv({ agent: 'codex', prompt: 'p', resumeSessionId: 'thread-1', model });
    expect(argv.slice(0, 2)).toEqual(['codex', 'exec']);
    expect(argv).not.toContain('resume');
    expect(argv).not.toContain('thread-1');
    expect(argv).toContain('sandbox_mode="read-only"');
    expect(argv.slice(argv.indexOf('-m'), argv.indexOf('-m') + 2)).toEqual(['-m', expected]);
    expect(argv.at(-1)).toBe('p');
  });
});

describe('commit and push steps', () => {
  it.each([
    ['a plain message', 'feat: add it'],
    ['shell syntax', 'fix: $(rm -rf ~) `id` "q" \'s\' ; | &&'],
    ['several lines', 'feat: add it\n\nBody line'],
  ])('the commit message stays one argument and is quoted safely: %s', (_name, message) => {
    const steps = commitAllSteps(message);
    expect(steps.map((s) => s.argv)).toEqual([
      ['git', 'add', '-A'],
      ['git', 'commit', '-m', message],
    ]);
    // Single-quoted: sh expands nothing inside, so nothing in the message runs.
    expect(toShellScript(steps)).toContain(`git commit -m ${shellQuote(message)}\n`);
    expect(shellQuote(message).startsWith("'")).toBe(true);
  });

  it.each([
    ['the drafted message', { title: 'feat: t', commitMessage: '  fix: c  ' }, 'fix: c'],
    ['the title when the message is blank', { title: ' feat: t ', commitMessage: '   ' }, 'feat: t'],
    ['the title when there is no message', { title: 'feat: t' }, 'feat: t'],
  ])('prCommitMessage uses %s', (_name, input, expected) => {
    expect(prCommitMessage(input)).toBe(expected);
  });

  it('counts commits ahead of the remote base, and both steps may fail', () => {
    const steps = commitsAheadSteps('main');
    expect(steps.map((s) => s.argv)).toEqual([
      ['git', 'fetch', 'origin', 'main'],
      ['git', 'rev-list', '--count', 'refs/remotes/origin/main..HEAD'],
    ]);
    expect(steps.every((s) => s.allowFailure)).toBe(true);
  });

  it.each([
    ['a count', '3\n', 3],
    ['zero', '0', 0],
    ['fetch noise before the count', 'From github.com:acme/app\n2\n', 2],
    ['nothing (the ref is missing)', '', null],
    ['an error line', 'fatal: bad revision', null],
  ])('parseCommitsAhead reads %s', (_name, stdout, expected) => {
    expect(parseCommitsAhead(stdout)).toBe(expected);
  });

  it('pushes HEAD with tracking and never prompts for a password', () => {
    expect(pushHeadStep()).toEqual({ argv: ['git', 'push', '-u', 'origin', 'HEAD'], env: { GIT_TERMINAL_PROMPT: '0' } });
  });
});

describe('describePushFailure', () => {
  const app403 =
    'remote: Write access to repository not granted.\nfatal: unable to access \'http://127.0.0.1:8080/gh/acme/app.git/\': The requested URL returned error: 403';

  it.each<[string, string, 'sandbox' | 'local', RegExp]>([
    ['a 403 in a sandbox names the App permission', app403, 'sandbox', /^GitHub refused the push\. The Talyn GitHub App needs Contents: Read & write on acme\/app\.\n/],
    ['a denied push on the user machine names their credentials', 'remote: Permission to acme/app.git denied to tom.', 'local', /^GitHub refused the push\. Check that your git credentials can write to acme\/app\./],
    ['a non-fast-forward', ' ! [rejected]        HEAD -> oslo (fetch first)', 'sandbox', /^GitHub rejected the push: the remote branch has commits/],
    ['anything else', 'fatal: unable to connect', 'local', /^Could not push the branch\.\nfatal: unable to connect$/],
  ])('%s', (_name, stderr, runtime, expected) => {
    expect(describePushFailure({ stderr, runtime, repoFullName: 'acme/app' })).toMatch(expected);
  });

  it('keeps only the last four lines of git output as the detail', () => {
    const stderr = ['one', 'two', 'three', 'four', 'five', 'error: 403'].join('\n');
    const text = describePushFailure({ stderr, runtime: 'sandbox', repoFullName: 'acme/app' });
    expect(text.split('\n').slice(1)).toEqual(['three', 'four', 'five', 'error: 403']);
  });
});
