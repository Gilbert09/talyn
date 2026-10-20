import type { AgentEvent, Workbench, WorkbenchEvent } from '@talyn/shared';
import {
  buildFileTree,
  chatInsights,
  chatTotals,
  compactCount,
  formatCommentsMessage,
  fuzzyMatchPaths,
  makeUserMessageEvent,
  nextActionInput,
  slashCommandsFrom,
  splitTurns,
  userMessageText,
  workbenchNextAction,
  type DiffComment,
  type WorkbenchPrLike,
} from '../renderer/lib/workbenchFormat';
import { applyTrigger, findTrigger } from '../renderer/components/workbench/ComposerPopover';
import { groupByRepository } from '../renderer/components/workbench/workbenchSelectors';
import { portFor } from '../renderer/lib/workbenchOps';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));

function pr(over: Partial<WorkbenchPrLike['summary']> & { state?: WorkbenchPrLike['state'] } = {}): WorkbenchPrLike {
  const { state = 'open', ...summary } = over;
  return { state, summary: { mergeable: 'MERGEABLE', ciStatus: 'passing', url: 'u', ...summary } };
}

const changed = { diffStat: { added: 3, removed: 1, files: 2 } };
const clean = { diffStat: null };

describe('next action', () => {
  it.each([
    ['no PR, no changes', clean, null, null],
    ['no PR, zero-file diff', { diffStat: { added: 0, removed: 0, files: 0 } }, null, null],
    ['no PR, changes', changed, null, 'create_pr'],
    ['merged PR', changed, pr({ state: 'merged' }), 'archive'],
    ['closed PR', clean, pr({ state: 'closed' }), 'archive'],
    ['conflicting', changed, pr({ mergeable: 'CONFLICTING', ciStatus: 'failing_required' }), 'resolve_conflicts'],
    ['required check failing', changed, pr({ ciStatus: 'failing_required' }), 'fix_checks'],
    ['only optional checks failing', changed, pr({ ciStatus: 'failing_optional' }), 'merge'],
    ['checks running', changed, pr({ ciStatus: 'running' }), null],
    ['needs a human gate', changed, pr({ ciStatus: 'needs_human' }), null],
    ['mergeability unknown', changed, pr({ mergeable: 'UNKNOWN' }), null],
    ['green', changed, pr({ ciStatus: 'passing' }), 'merge'],
    ['no checks configured', changed, pr({ ciStatus: 'none' }), 'merge'],
    ['no CI verdict on an old row', changed, pr({ ciStatus: undefined }), 'merge'],
  ] as const)('%s', (_name, wb, prLike, expected) => {
    expect(workbenchNextAction(wb as Pick<Workbench, 'diffStat'>, prLike)).toBe(expected);
  });

  it('maps the PR fields onto the shared input', () => {
    expect(nextActionInput(changed, pr({ mergeable: 'CONFLICTING', ciStatus: 'running' }))).toEqual({
      hasChanges: true,
      pr: { state: 'open', mergeable: 'conflicting', ciStatus: 'pending' },
    });
  });
});

describe('formatCommentsMessage', () => {
  const c = (over: Partial<DiffComment>): DiffComment => ({
    id: Math.random().toString(),
    path: 'src/a.ts',
    side: 'additions',
    startLine: 1,
    endLine: 1,
    text: 'fix',
    ...over,
  });

  it('is empty for no comments', () => {
    expect(formatCommentsMessage([])).toBe('');
  });

  it('formats one comment', () => {
    expect(formatCommentsMessage([c({ startLine: 12, endLine: 12, text: 'Rename this.' })])).toBe(
      'I left a comment on the diff. Address it:\n\n`src/a.ts`\n- line 12: Rename this.'
    );
  });

  it('groups by file in first-comment order and sorts lines within a file', () => {
    const msg = formatCommentsMessage([
      c({ path: 'b.ts', startLine: 9, endLine: 9, text: 'B late' }),
      c({ path: 'a.ts', startLine: 3, endLine: 5, text: 'A range' }),
      c({ path: 'b.ts', startLine: 2, endLine: 2, text: 'B early' }),
    ]);
    expect(msg).toBe(
      [
        'I left 3 comments on the diff. Address each one:',
        '',
        '`b.ts`',
        '- line 2: B early',
        '- line 9: B late',
        '',
        '`a.ts`',
        '- lines 3-5: A range',
      ].join('\n')
    );
  });

  it.each([
    ['marks a comment on removed lines', c({ side: 'deletions', startLine: 4, endLine: 4 }), '- line 4 (removed side): fix'],
    ['indents a multi-line comment', c({ text: 'one\n\ntwo' }), '- line 1: one\n  two'],
    ['trims the comment', c({ text: '  spaced  ' }), '- line 1: spaced'],
  ])('%s', (_n, comment, expectedLine) => {
    expect(formatCommentsMessage([comment])).toContain(expectedLine);
  });
});

describe('transcript turns', () => {
  const we = (seq: number, turn: number, event: Partial<AgentEvent>): WorkbenchEvent => ({
    chatId: 'c1',
    seq,
    turn,
    event: { seq, type: 'assistant', ...event } as AgentEvent,
  });
  const user = (seq: number, turn: number, text: string) =>
    we(seq, turn, { ...(makeUserMessageEvent(text) as Partial<AgentEvent>) });

  it.each([
    ['our own user message', makeUserMessageEvent('hello'), 'hello'],
    ['a string content', { type: 'user', message: { role: 'user', content: 'plain' } }, 'plain'],
    ['a talyn_user_message event', { type: 'talyn_user_message', text: 'direct' }, 'direct'],
    ['a tool result is not a message', { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }, null],
    ['an assistant event', { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }, null],
  ])('userMessageText: %s', (_n, event, expected) => {
    expect(userMessageText({ seq: 1, ...event } as AgentEvent)).toBe(expected);
  });

  it('splits by turn, each led by its user message', () => {
    const turns = splitTurns([
      user(1, 1, 'first'),
      we(2, 1, {}),
      we(3, 1, { type: 'result' }),
      user(4, 2, 'second'),
      we(5, 2, {}),
    ]);
    expect(turns.map((t) => [t.turn, t.userText, t.userSeq, t.events.map((e) => e.seq)])).toEqual([
      [1, 'first', 1, [2, 3]],
      [2, 'second', 4, [5]],
    ]);
  });

  it('keeps a turn whose user message was never recorded', () => {
    const turns = splitTurns([we(1, 1, {}), we(2, 1, {})]);
    expect(turns).toHaveLength(1);
    expect(turns[0].userText).toBeNull();
    expect(turns[0].events).toHaveLength(2);
  });
});

describe('chatTotals', () => {
  const result = (seq: number, extra: Record<string, unknown>): WorkbenchEvent => ({
    chatId: 'c1',
    seq,
    turn: seq,
    event: { seq, type: 'result', ...extra } as AgentEvent,
  });

  it('adds up every turn, cache tokens included', () => {
    const events = [
      result(1, { total_cost_usd: 0.05, usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 20 } }),
      { chatId: 'c1', seq: 2, turn: 2, event: { seq: 2, type: 'assistant' } as AgentEvent },
      result(3, { total_cost_usd: 0.01, is_error: true, usage: { input_tokens: 3, output_tokens: 5 } }),
    ];
    const totals = chatTotals(events);
    expect(totals.turns).toBe(2);
    expect(totals.costUsd).toBeCloseTo(0.06);
    expect(totals.inputTokens).toBe(115);
    expect(totals.outputTokens).toBe(25);
  });

  it('has no cost when no turn reported one', () => {
    expect(chatTotals([result(1, { usage: { output_tokens: 4 } })])).toEqual({
      turns: 1,
      costUsd: null,
      inputTokens: 0,
      outputTokens: 4,
    });
    expect(chatTotals([]).turns).toBe(0);
  });

  it.each([
    [0, '0'],
    [999, '999'],
    [1000, '1k'],
    [48_213, '48k'],
    [9_950, '9.9k'],
    [1_204_000, '1.2M'],
  ])('compactCount(%i) is %s', (n, out) => {
    expect(compactCount(n)).toBe(out);
  });
});

describe('chatInsights', () => {
  const we = (seq: number, event: Record<string, unknown>): WorkbenchEvent => ({
    chatId: 'c1',
    seq,
    turn: 1,
    event: { seq, ...event } as AgentEvent,
  });
  const todoWrite = (todos: unknown[]) => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos } }] },
  });

  it('is empty for no events', () => {
    expect(chatInsights([])).toEqual({ todos: null, contextUsage: null, slashCommands: null });
  });

  it.each([
    [
      'takes the latest init and combines commands and skills',
      [
        we(1, { type: 'system', subtype: 'init', slash_commands: ['old'] }),
        we(2, { type: 'system', subtype: 'init', slash_commands: ['/review', 'compact', '/', 42], skills: ['/review', 'deploy', '//audit', ''] }),
      ],
      ['audit', 'compact', 'deploy', 'review'],
    ],
    ['returns null when the init has neither array', [we(1, { type: 'system', subtype: 'init' })], null],
    ['keeps an empty list when arrays exist', [we(1, { type: 'system', subtype: 'init', slash_commands: [], skills: [] })], []],
    ['reads skills without commands', [we(1, { type: 'system', subtype: 'init', skills: ['/test'] })], ['test']],
  ] as const)('%s', (_name, events, expected) => {
    expect(chatInsights([...events]).slashCommands).toEqual(expected);
  });

  it('takes the latest TodoWrite and the last top-level usage', () => {
    const insights = chatInsights([
      we(1, { type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' }),
      we(2, todoWrite([{ content: 'old', status: 'pending' }])),
      we(3, { type: 'assistant', message: { content: [], usage: { input_tokens: 10, cache_read_input_tokens: 90 } } }),
      we(4, todoWrite([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }])),
      we(5, {
        type: 'assistant',
        parent_tool_use_id: 'sub',
        message: { content: [], usage: { input_tokens: 99_999 } },
      }),
      we(6, { type: 'assistant', message: { content: [], usage: { input_tokens: 1000, cache_creation_input_tokens: 1000 } } }),
    ]);
    expect(insights.todos?.map((t) => t.content)).toEqual(['a', 'b']);
    expect(insights.contextUsage).toEqual({ usedTokens: 2000, contextWindow: 200_000, fraction: 0.01 });
  });
});

describe('files', () => {
  it('builds a tree with folders first', () => {
    const tree = buildFileTree(['src/b.ts', 'README.md', 'src/a/x.ts', 'package.json']);
    expect(tree.map((n) => n.name)).toEqual(['src', 'package.json', 'README.md']);
    expect(tree[0].children?.map((n) => n.name)).toEqual(['a', 'b.ts']);
    expect(tree[0].children?.[0].children?.[0]).toEqual({ name: 'x.ts', path: 'src/a/x.ts', children: null });
  });

  it.each([
    ['empty query keeps the order', '', ['b/x.ts', 'a/y.ts'], ['b/x.ts', 'a/y.ts']],
    ['file-name hit beats a directory hit', 'app', ['app/zzz.ts', 'src/app.ts'], ['src/app.ts', 'app/zzz.ts']],
    ['drops a path missing a character', 'xyz', ['x/y.ts', 'a.ts'], []],
    ['matches characters in order', 'sat', ['src/app.ts', 'tas.ts'], ['src/app.ts']],
  ])('fuzzyMatchPaths: %s', (_n, query, paths, expected) => {
    expect(fuzzyMatchPaths(query, paths)).toEqual(expected);
  });

  it.each([
    ['commands, including nested commands', ['.claude/commands/review.md', '.claude/commands/git/sync.md'], ['git:sync', 'review']],
    ['skills at the exact depth', ['.claude/skills/deploy/SKILL.md', '.claude/skills/review/SKILL.md'], ['deploy', 'review']],
    ['deeper skill paths and other files', ['.claude/skills/deploy/nested/SKILL.md', '.claude/skills/deploy/notes.md', '.claude/skills/SKILL.md'], []],
    ['duplicate names across files', ['.claude/commands/review.md', '.claude/skills/review/SKILL.md', '.claude/skills/review/SKILL.md'], ['review']],
    ['unrelated paths', ['.claude/other.md', 'docs/commands/x.md'], []],
  ])('slashCommandsFrom: %s', (_name, paths, expected) => {
    expect(slashCommandsFrom(paths)).toEqual(expected);
  });
});

describe('composer triggers', () => {
  it.each([
    ['a mention at the start', '@sr', 3, { kind: 'mention', query: 'sr', start: 0, end: 3 }],
    ['a mention after a space', 'look at @src/a', 14, { kind: 'mention', query: 'src/a', start: 8, end: 14 }],
    ['an email is not a mention', 'mail me@x', 9, null],
    ['a slash command at the start', '/rev', 4, { kind: 'slash', query: 'rev', start: 0, end: 4 }],
    ['a slash mid-text is not a command', 'see a/b', 7, null],
    ['nothing after a space', '@src ', 5, null],
  ])('findTrigger: %s', (_n, text, caret, expected) => {
    expect(findTrigger(text, caret)).toEqual(expected);
  });

  it('applies a mention and moves the caret past it', () => {
    const text = 'look at @sr please';
    const trigger = findTrigger(text, 11);
    expect(trigger).not.toBeNull();
    expect(applyTrigger(text, trigger!, 'src/app.ts')).toEqual({ text: 'look at @src/app.ts  please', caret: 20 });
  });

  it('applies a slash command', () => {
    const trigger = findTrigger('/re', 3)!;
    expect(applyTrigger('/re', trigger, 'review')).toEqual({ text: '/review ', caret: 8 });
  });
});

describe('sidebar order', () => {
  const wb = (id: string, repo: string, createdAt: string) => ({ id, repoFullName: repo, createdAt }) as Workbench;

  it('groups by repository alphabetically, oldest first within a repository', () => {
    const groups = groupByRepository([
      wb('3', 'zeta/app', '2026-10-01'),
      wb('2', 'acme/app', '2026-10-03'),
      wb('1', 'acme/app', '2026-10-02'),
    ]);
    expect(groups.map((g) => [g.repo, g.items.map((w) => w.id)])).toEqual([
      ['acme/app', ['1', '2']],
      ['zeta/app', ['3']],
    ]);
  });
});

describe('portFor', () => {
  it.each(['wb-1', 'wb-2', 'a-much-longer-workbench-id'])('gives %s a stable port block in range', (id) => {
    const port = portFor(id);
    expect(port).toBe(portFor(id));
    expect(port % 10).toBe(0);
    expect(port).toBeGreaterThanOrEqual(40000);
    expect(port + 9).toBeLessThan(60000);
  });
});
