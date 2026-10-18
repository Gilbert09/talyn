import { describe, expect, it } from 'vitest';
import {
  buildBlocks,
  buildClaudeArgv,
  buildCreatePrTurnInstructions,
  commitAllSteps,
  commitsAheadSteps,
  CREATE_PR_MESSAGE,
  createPrTurnPrompt,
  describePushFailure,
  MISSING_PR_BLOCK_MESSAGE,
  parseCommitsAhead,
  parsePrDetails,
  prCommitMessage,
  pullRequestOutcomeEvent,
  pushHeadStep,
  shellQuote,
  toShellScript,
  type AgentEvent,
} from '@talyn/shared';

describe('parsePrDetails', () => {
  const json = '{"title":"feat: add it","body":"## Summary\\nAdds it.","commitMessage":"feat: wip","draft":false}';
  const expected = { title: 'feat: add it', body: '## Summary\nAdds it.', commitMessage: 'feat: wip', draft: false };
  const block = (body: string, lang = 'talyn-pr') => `\`\`\`${lang}\n${body}\n\`\`\``;

  it.each<[string, string]>([
    ['a talyn-pr block after a summary', `I added the thing and its tests.\n\n${block(json)}`],
    ['a talyn-pr block with trailing spaces on the fence', `\`\`\`talyn-pr   \n${json}\n\`\`\``],
    ['the last talyn-pr block wins', `${block('{"title":"old","body":"x"}')}\nBetter:\n${block(json)}`],
    ['a talyn-pr block wins over a later json block', `${block(json)}\n${block('{"title":"other","body":"y"}', 'json')}`],
    ['a json block when there is no talyn-pr block', `Here:\n${block(json, 'json')}`],
    ['the last json block wins', `${block('{"title":"old"}', 'json')}\n${block(json, 'json')}`],
    ['a talyn-pr block with no title falls back to json', `${block(json, 'json')}\n${block('{"note":"x"}')}`],
  ])('reads %s', (_name, text) => {
    expect(parsePrDetails(text)).toEqual({ ok: true, details: expected });
  });

  it.each<[string, string, string]>([
    ['braces inside the body string', '{"title":"t","body":"Adds {it}."}', 'Adds {it}.'],
    ['a code fence inside the body string', '{"title":"t","body":"Run:\\n```bash\\nnpm test\\n```\\nDone."}', 'Run:\n```bash\nnpm test\n```\nDone.'],
  ])('keeps %s', (_name, object, body) => {
    const result = parsePrDetails(block(object));
    expect(result.ok && result.details.body).toBe(body);
  });

  it.each<[string, string, Partial<Record<'title' | 'body' | 'commitMessage' | 'draft', unknown>>]>([
    ['missing fields default', '{"title":"fix: x"}', { title: 'fix: x', body: '', commitMessage: '', draft: false }],
    ['draft true is kept', '{"title":"fix: x","draft":true}', { draft: true }],
    ['a draft that is not a boolean is false', '{"title":"fix: x","draft":"yes"}', { draft: false }],
    ['a multi-line title collapses to one line', '{"title":"fix:\\n  x  y","body":""}', { title: 'fix: x y' }],
    ['non-string fields are dropped', '{"title":"fix: x","body":3,"commitMessage":null}', { body: '', commitMessage: '' }],
  ])('%s', (_name, object, fields) => {
    const result = parsePrDetails(block(object));
    expect(result.ok && result.details).toMatchObject(fields);
  });

  it('caps the title at GitHub’s 256 characters', () => {
    const result = parsePrDetails(block(JSON.stringify({ title: 'x'.repeat(400), body: '' })));
    expect(result.ok && result.details.title.length).toBe(256);
  });

  it.each([
    ['empty text', ''],
    ['prose only', 'I could not find any changes.'],
    ['a bare object with no fence', json],
    ['a plain fence', `\`\`\`\n${json}\n\`\`\``],
    ['a blank title', block('{"title":"   ","body":"x"}')],
    ['a title that is not a string', block('{"title":42,"body":"x"}')],
    ['broken JSON', '```talyn-pr\n{"title": "x", \n```'],
    ['an array', block('["title", "x"]')],
  ])('refuses %s', (_name, text) => {
    expect(parsePrDetails(text)).toEqual({ ok: false, error: MISSING_PR_BLOCK_MESSAGE });
  });
});

describe('buildCreatePrTurnInstructions', () => {
  it('names the branch and base, the hands-off rule, the template paths and the block', () => {
    const text = buildCreatePrTurnInstructions({ branch: 'oslo', baseBranch: 'develop' });
    for (const part of [
      '`oslo`',
      'merged into `develop`',
      'Do not commit, push or open the pull request',
      'do not run `gh`',
      'git diff origin/develop...HEAD',
      'git status',
      '.github/pull_request_template.md',
      '.github/PULL_REQUEST_TEMPLATE.md',
      '.github/PULL_REQUEST_TEMPLATE/',
      'docs/pull_request_template.md',
      '```talyn-pr',
      '"title"',
      '"body"',
      '"commitMessage"',
      '"draft"',
      'under 72 characters',
    ]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain('Extra instructions');
  });

  it.each([
    ['appended when set', 'Link the Linear ticket.', true],
    ['skipped when blank', '   ', false],
    ['skipped when null', null, false],
    ['skipped when absent', undefined, false],
  ])('extra instructions are %s', (_name, extra, present) => {
    const text = buildCreatePrTurnInstructions({ branch: 'b', baseBranch: 'main', extra });
    expect(text.includes('Extra instructions for this pull request:')).toBe(present);
    if (present) expect(text.trimEnd().endsWith('Link the Linear ticket.')).toBe(true);
  });
});

describe('createPrTurnPrompt', () => {
  it('Claude: the visible text is the prompt, the instructions an appended system prompt', () => {
    const turn = createPrTurnPrompt({ agent: 'claude', text: CREATE_PR_MESSAGE, instructions: 'HIDDEN' });
    expect(turn).toEqual({ prompt: 'Create a pull request', appendSystemPrompt: 'HIDDEN' });
    const argv = buildClaudeArgv({ prompt: turn.prompt, appendSystemPrompt: turn.appendSystemPrompt });
    expect(argv.slice(argv.indexOf('--append-system-prompt'), argv.indexOf('--append-system-prompt') + 2)).toEqual([
      '--append-system-prompt',
      'HIDDEN',
    ]);
    expect(argv.slice(-2)).toEqual(['--', 'Create a pull request']);
  });

  it('Codex: the instructions go in front of the text, with no system prompt', () => {
    const turn = createPrTurnPrompt({ agent: 'codex', text: CREATE_PR_MESSAGE, instructions: 'HIDDEN' });
    expect(turn.appendSystemPrompt).toBeUndefined();
    expect(turn.prompt.startsWith('HIDDEN')).toBe(true);
    expect(turn.prompt.endsWith('Create a pull request')).toBe(true);
  });
});

describe('pullRequestOutcomeEvent in the transcript', () => {
  const render = (event: Record<string, unknown>) => buildBlocks([{ seq: 7, ...event } as AgentEvent]);

  it.each<[string, Parameters<typeof pullRequestOutcomeEvent>[0], Record<string, unknown>]>([
    [
      'an opened PR links it',
      { ok: true, number: 12, url: 'https://github.com/acme/app/pull/12', existing: false },
      { text: 'Opened pull request #12', url: 'https://github.com/acme/app/pull/12', isError: false },
    ],
    [
      'an existing PR says it was linked',
      { ok: true, number: 9, url: 'https://github.com/acme/app/pull/9', existing: true },
      { text: 'Linked the open pull request #9', isError: false },
    ],
    [
      'a failure carries its message',
      { ok: false, message: 'GitHub refused the push. The Talyn GitHub App needs Contents: Read & write on acme/app.' },
      { text: 'GitHub refused the push. The Talyn GitHub App needs Contents: Read & write on acme/app.', isError: true },
    ],
  ])('%s', (_name, outcome, block) => {
    expect(pullRequestOutcomeEvent(outcome).type).toBe('talyn_pr');
    expect(render(pullRequestOutcomeEvent(outcome))).toEqual([
      expect.objectContaining({ kind: 'system', subtype: 'talyn_pr', key: '7', ...block }),
    ]);
  });

  it('a failure has no link', () => {
    expect(render(pullRequestOutcomeEvent({ ok: false, message: 'x' }))[0]).not.toHaveProperty('url');
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
    ['the agent’s message', { title: 'feat: t', commitMessage: '  fix: c  ' }, 'fix: c'],
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
