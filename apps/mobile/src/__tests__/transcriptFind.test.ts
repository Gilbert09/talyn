import type { ToolBlock, ToolGroupBlock } from '@talyn/shared';

import type { TranscriptRow as Row } from '../features/chat/transcript';
import {
  findMatches, highlightParts, markdownText, matchCountLabel, normalizeQuery, occurrences, rowSearchText, selectedIndex, stepIndex,
} from '../features/chat/transcriptFind';

const tool = (patch: Partial<ToolBlock> = {}): ToolBlock => ({ kind: 'tool', key: '3.0', toolId: 't1', name: 'Bash', input: { command: 'npm test' },
  output: 'hidden output', isError: false, stopped: false, settled: true, ...patch });
const group = (patch: Partial<ToolGroupBlock> = {}): ToolGroupBlock => ({
  kind: 'tool_group', key: 'group-4', summary: 'Ran 2 commands', running: false, isError: false, failedCount: 0, lastFailed: false,
  tools: [], children: [tool({ key: '4.0', toolId: 'g1', input: { command: 'npm run lint' } }), tool({ key: '4.1', toolId: 'g2', input: { command: 'npm run build' } })],
  ...patch,
} as ToolGroupBlock);
const base = { key: 'k', timestamp: null };
const user = (key: string, text: string): Row => ({ ...base, key, kind: 'user', text, attachments: 0, files: [] });
const agent = (key: string, text: string): Row => ({ ...base, key, kind: 'text', text, streaming: false });

describe('normalizeQuery and occurrences', () => {
  it.each([
    ['', ''], ['   ', ''], ['  Build  ', 'build'], ['MiXeD', 'mixed'], ['\tfoo\n', 'foo'],
  ])('normalizes %j to %j', (query, expected) => {
    expect(normalizeQuery(query)).toBe(expected);
  });
  it.each([
    ['empty query', 'some text', '', []],
    ['whitespace query', 'some text', '   ', []],
    ['no match', 'some text', 'zzz', []],
    ['case-insensitive', 'Build the BUILD', 'build', [0, 10]],
    ['trimmed query', 'a build here', '  build ', [2]],
    ['several in one word', 'aaaa', 'aa', [0, 2]],
    ['inner spaces kept', 'run npm test now', 'npm test', [4]],
  ])('%s', (_name, text, query, expected) => {
    expect(occurrences(text, query)).toEqual(expected);
  });
});

describe('markdownText', () => {
  it.each([
    ['plain text', 'Hello world', 'Hello world'],
    ['emphasis drops its syntax', 'A **bold** and _em_ word', 'A bold and em word'],
    ['link shows its text, not its URL', 'See [the docs](https://example.com/x)', 'See the docs'],
    ['inline code keeps its text', 'Run `npm test`', 'Run npm test'],
    ['heading', '## Title', 'Title'],
    ['list items, no markers', '- one\n- two', 'one\ntwo'],
    ['code block', '```sh\nnpm run build\n```', 'npm run build'],
    ['quote', '> quoted words', 'quoted words'],
    ['table cells', '| a | b |\n| - | - |\n| c | d |', 'a\nb\nc\nd'],
  ])('%s', (_name, source, expected) => {
    expect(markdownText(source)).toBe(expected);
  });
});

describe('rowSearchText gives the text a row shows before it opens', () => {
  it.each<[string, Row, string[], string[]]>([
    ['user message', user('u', 'Please **build** it'), ['Please build it'], ['**']],
    ['agent text', agent('a', 'Done. See [PR](https://example.com/pr/1)'), ['Done. See PR'], ['example.com']],
    ['thinking shows its first line only', { ...base, kind: 'thinking', text: '\n  First idea\nSecret second line' }, ['First idea'], ['Secret']],
    ['tool shows its line, not its output', { ...base, kind: 'tool', tool: tool(), partial: false }, ['npm test'], ['hidden output']],
    ['a stopped tool says so', { ...base, kind: 'tool', tool: tool({ stopped: true }), partial: false }, ['stopped'], []],
    ['a failed tool shows its error preview', { ...base, kind: 'tool', tool: tool({ isError: true, output: 'line 1\nline 2\nline 3\nline 4' }), partial: false },
      ['Error', 'line 3'], ['line 4']],
    ['a closed tool group shows its summary only', { ...base, kind: 'tool_group', group: group(), partial: [] }, ['Ran 2 commands'], ['npm run lint']],
    ['a group whose last call failed shows its calls', { ...base, kind: 'tool_group', group: group({ lastFailed: true, isError: true, failedCount: 1 }), partial: [] },
      ['Ran 2 commands · 1 failed', 'npm run lint', 'npm run build'], []],
    ['a running group stays closed', { ...base, kind: 'tool_group', group: group({ lastFailed: true, running: true }), partial: [] }, ['Ran 2 commands'], ['npm run lint']],
    ['permission', { ...base, kind: 'permission', toolName: 'Bash', toolInput: { command: 'rm -rf build' }, status: 'denied', persist: false },
      ['Denied Bash', 'rm -rf build'], []],
    ['permission for the session', { ...base, kind: 'permission', toolName: 'Edit', toolInput: {}, status: 'allowed', persist: true },
      ['Allowed Edit for this session'], []],
    ['system line', { ...base, kind: 'system', text: 'Opened pull request #4', isError: false }, ['Opened pull request #4'], []],
    ['interruption', { ...base, kind: 'system', text: 'raw', subtype: 'talyn_interruption', isError: false }, ['Interrupted'], ['raw']],
    ['box refusal', { ...base, kind: 'system', text: 'Add hours.', subtype: 'usage_exhausted', isError: false }, ['Out of hours. Add hours.'], []],
    ['code review card', { ...base, kind: 'system', text: 'Code review failed. Runner crashed', subtype: 'talyn_code_review', isError: true },
      ['Code review failed. Runner crashed'], []],
    ['long Talyn message is cut', { ...base, kind: 'system', text: `${'x'.repeat(280)}TAIL`, subtype: 'talyn_message', isError: false }, ['x…'], ['TAIL']],
    ['failed turn', { ...base, kind: 'failed', text: 'Out of memory' }, ['Turn failed. Out of memory'], []],
    ['stopped', { ...base, kind: 'stopped' }, ['Stopped'], []],
    ['queued', { ...base, kind: 'queued', text: 'Next step', fromTalyn: false }, ['Next step', 'Queued'], []],
    ['queued from Talyn', { ...base, kind: 'queued', text: 'Wake', fromTalyn: true }, ['From Talyn'], []],
    ['plan', { ...base, kind: 'plan', plan: '1. **Add** a test', state: 'approved' }, ['Plan Approved', 'Add a test'], ['**']],
    ['broken', { ...base, kind: 'broken' }, ['could not be shown'], []],
  ])('%s', (_name, row, present, absent) => {
    const text = rowSearchText(row);
    for (const part of present) expect(text).toContain(part);
    for (const part of absent) expect(text).not.toContain(part);
  });
  it('gives the same text for the same row object', () => {
    const row = agent('a', 'Hello');
    expect(rowSearchText(row)).toBe(rowSearchText(row));
  });
  it('gives empty text for a row it cannot read', () => {
    expect(rowSearchText({ ...base, kind: 'tool', tool: null, partial: false } as unknown as Row)).toBe('');
  });
});

describe('findMatches', () => {
  const rows = [user('r0', 'Fix the build'), agent('r1', 'The BUILD failed. Build again?'), agent('r2', 'Nothing here'), user('r3', 'build it')];
  it.each([
    ['empty query', '', []],
    ['whitespace query', '   ', []],
    ['no match', 'deploy', []],
  ])('%s gives no matches', (_name, query, expected) => {
    expect(findMatches(rows, query)).toEqual(expected);
  });
  it('gives one entry per occurrence, in row order', () => {
    expect(findMatches(rows, ' Build ')).toEqual([
      { rowKey: 'r0', rowIndex: 0, occurrence: 0 },
      { rowKey: 'r1', rowIndex: 1, occurrence: 0 },
      { rowKey: 'r1', rowIndex: 1, occurrence: 1 },
      { rowKey: 'r3', rowIndex: 3, occurrence: 0 },
    ]);
  });
  it('does not match hidden tool output', () => {
    expect(findMatches([{ ...base, kind: 'tool', tool: tool(), partial: false }], 'hidden output')).toEqual([]);
  });
});

describe('selection', () => {
  const matches = [
    { rowKey: 'a', rowIndex: 0, occurrence: 0 },
    { rowKey: 'b', rowIndex: 1, occurrence: 0 },
    { rowKey: 'b', rowIndex: 1, occurrence: 1 },
    { rowKey: 'c', rowIndex: 2, occurrence: 0 },
  ];
  it.each([
    ['no matches', [], { rowKey: 'a', occurrence: 0 }, -1],
    ['no selection selects the newest', matches, null, 3],
    ['the same occurrence', matches, { rowKey: 'b', occurrence: 1 }, 2],
    ['a gone occurrence keeps the row', matches, { rowKey: 'b', occurrence: 5 }, 2],
    ['a gone row selects the newest', matches, { rowKey: 'z', occurrence: 0 }, 3],
  ])('%s', (_name, list, selected, expected) => {
    expect(selectedIndex(list, selected)).toBe(expected);
  });
  it('keeps the selection by key when new rows arrive', () => {
    const before = findMatches([agent('a', 'test'), agent('b', 'test')], 'test');
    const after = findMatches([agent('z', 'test'), agent('a', 'test'), agent('b', 'test'), agent('c', 'test')], 'test');
    const selected = { rowKey: before[0].rowKey, occurrence: before[0].occurrence };
    expect(after[selectedIndex(after, selected)].rowKey).toBe('a');
  });
  it.each([
    [0, 4, 1, 1], [3, 4, 1, 0], [0, 4, -1, 3], [2, 4, -1, 1], [-1, 4, 1, 0], [-1, 4, -1, 3], [0, 0, 1, -1], [0, 1, 1, 0], [0, 1, -1, 0],
  ] as const)('step from %i of %i by %i is %i', (index, count, step, expected) => {
    expect(stepIndex(index, count, step)).toBe(expected);
  });
  it.each([
    [0, 0, '', ''], [0, 0, '  ', ''], [-1, 0, 'x', 'No results'], [0, 3, 'x', '1 of 3'], [2, 3, 'x', '3 of 3'],
  ])('label for %i of %i with %j is %j', (index, count, query, expected) => {
    expect(matchCountLabel(index, count, query)).toBe(expected);
  });
});

describe('highlightParts', () => {
  it.each([
    ['no query', 'Hello', '', [{ text: 'Hello', match: false }]],
    ['no match', 'Hello', 'z', [{ text: 'Hello', match: false }]],
    ['whole text', 'Hello', 'HELLO', [{ text: 'Hello', match: true }]],
    ['middle', 'a Build b', 'build', [{ text: 'a ', match: false }, { text: 'Build', match: true }, { text: ' b', match: false }]],
    ['several', 'ab ab', 'ab', [{ text: 'ab', match: true }, { text: ' ', match: false }, { text: 'ab', match: true }]],
  ])('%s', (_name, text, query, expected) => {
    expect(highlightParts(text, query)).toEqual(expected);
  });
});
