import { describe, expect, it } from 'vitest';
import {
  buildBlocks,
  claudeProjectSlug,
  claudePromptText,
  claudeSessionToEvents,
  isClaudeSessionId,
  type AgentEvent,
} from '@talyn/shared';

/** A synthetic Claude Code conversation file: every line shape the converter must keep or drop. */
const SESSION = '4f1c2b9e-1111-4222-8333-944455556666';
const at = (n: number) => `2026-10-20T10:00:${String(n).padStart(2, '0')}.000Z`;
const base = { sessionId: SESSION, cwd: '/Users/x/dev/app', gitBranch: 'feature', version: '2.1.0', userType: 'external' };

function user(uuid: string, parentUuid: string | null, content: unknown, extra: Record<string, unknown> = {}) {
  return { ...base, type: 'user', uuid, parentUuid, timestamp: at(0), message: { role: 'user', content }, ...extra };
}
function assistant(uuid: string, parentUuid: string, content: unknown[], extra: Record<string, unknown> = {}) {
  return {
    ...base,
    type: 'assistant',
    uuid,
    parentUuid,
    timestamp: at(1),
    message: { id: `msg-${uuid}`, role: 'assistant', model: 'claude-test', content, usage: { input_tokens: 10, output_tokens: 2 } },
    ...extra,
  };
}

const LONG = 'x'.repeat(50);

const lines = [
  { type: 'mode', mode: 'default' },
  { type: 'file-history-snapshot', messageId: 'm0', snapshot: {}, isSnapshotUpdate: false },
  { type: 'summary', summary: 'Old summary', leafUuid: 'gone' },
  user('meta-1', null, '<local-command-caveat>Caveat: ignore</local-command-caveat>', { isMeta: true }),
  user('cmd-1', 'meta-1', '<command-name>/clear</command-name>\n<command-message>clear</command-message>'),
  user('u1', null, 'Fix the login bug', { promptId: 'p1' }),
  { ...base, type: 'attachment', uuid: 'att-1', parentUuid: 'u1', attachment: { type: 'hook' } },
  assistant('a1', 'u1', [{ type: 'thinking', thinking: 'Look at auth.ts', signature: 'sig-secret' }]),
  assistant('a2', 'a1', [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/Users/x/dev/app/auth.ts' } }]),
  user('r1', 'a2', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: LONG }], { toolUseResult: { big: true } }),
  assistant('side-1', 'r1', [{ type: 'text', text: 'subagent chatter' }], { isSidechain: true }),
  assistant('a3', 'r1', [{ type: 'text', text: 'Fixed it.' }]),
  { ...base, type: 'system', subtype: 'turn_duration', uuid: 'sys-1', parentUuid: 'a3', durationMs: 5 },
  // A rewind: this branch was abandoned, the conversation went on from a3 with u2.
  user('x1', 'a3', 'abandoned prompt'),
  assistant('x2', 'x1', [{ type: 'text', text: 'abandoned answer' }]),
  user('u2', 'a3', [{ type: 'text', text: 'Now add a test' }, { type: 'image', source: { type: 'base64', data: 'AAAA' } }]),
  assistant('a4', 'u2', [{ type: 'tool_use', id: 'toolu_2', name: 'Write', input: { file_path: 'a.test.ts', content: LONG } }]),
  user('r2', 'a4', [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'ok' }, { type: 'image', source: {} }], is_error: true }]),
  assistant('a5', 'r2', [{ type: 'text', text: 'Done.' }]),
  { type: 'last-prompt', lastPrompt: 'Now add a test', leafUuid: 'a5' },
  { type: 'ai-title', aiTitle: 'Fix login' },
].map((l) => JSON.stringify(l));

describe('claudeSessionToEvents', () => {
  const { events, turns } = claudeSessionToEvents([...lines, 'not json', ''], { maxToolTextChars: 20 });
  const shapes = events.map(({ turn, event }) => {
    const content = (event.message as { content: Array<Record<string, unknown>> }).content;
    return `${turn}:${event.type}:${content.map((b) => b.type).join(',')}`;
  });

  it('keeps prompts, assistant blocks and tool results of the current branch, in order', () => {
    expect(turns).toBe(2);
    expect(shapes).toEqual([
      '1:user:text',
      '1:assistant:thinking',
      '1:assistant:tool_use',
      '1:user:tool_result',
      '1:assistant:text',
      '2:user:text',
      '2:assistant:tool_use',
      '2:user:tool_result',
      '2:assistant:text',
    ]);
  });

  it('writes prompts in the shape a live turn stores', () => {
    expect(events[0].event).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Fix the login bug' }] },
      talyn: { kind: 'user_message', messageId: 'u1', imported: true },
    });
    expect((events[5].event.message as { content: Array<{ text: string }> }).content[0].text).toBe(
      'Now add a test\n\n(An image not shown.)',
    );
  });

  it.each(['abandoned', 'subagent chatter', '/clear', 'Caveat', 'sig-secret', 'Old summary', 'toolUseResult', 'AAAA'])(
    'drops %s',
    (needle) => {
      expect(JSON.stringify(events)).not.toContain(needle);
    },
  );

  it('trims long tool text and replaces images', () => {
    const result = (events[3].event.message as { content: Array<{ content: string }> }).content[0].content;
    expect(result.startsWith('x'.repeat(20))).toBe(true);
    expect(result).toContain('30 more characters not imported');
    const write = (events[6].event.message as { content: Array<{ input: { content: string; file_path: string } }> }).content[0];
    expect(write.input.file_path).toBe('a.test.ts');
    expect(write.input.content).toContain('30 more characters not imported');
    const second = (events[7].event.message as { content: Array<{ content: unknown; is_error: boolean }> }).content[0];
    expect(second).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_2',
      is_error: true,
      content: [{ type: 'text', text: 'ok' }, { type: 'text', text: '(Image not shown.)' }],
    });
  });

  it('keeps model, id and usage on assistant events, and the session id', () => {
    expect(events[1].event).toMatchObject({
      type: 'assistant',
      session_id: SESSION,
      message: { id: 'msg-a1', model: 'claude-test', usage: { input_tokens: 10 }, content: [{ type: 'thinking', thinking: 'Look at auth.ts' }] },
    });
  });

  it('renders through buildBlocks with each result paired to its call', () => {
    const blocks = buildBlocks(events.map((e, i) => ({ ...e.event, seq: i + 1 }) as AgentEvent));
    const result = blocks.find((b) => b.kind === 'tool_result' && b.toolId === 'toolu_1');
    expect(result).toMatchObject({ toolName: 'Read' });
  });

  it('follows a compaction boundary through logicalParentUuid', () => {
    const compacted = [
      user('c1', null, 'first prompt'),
      assistant('c2', 'c1', [{ type: 'text', text: 'first answer' }]),
      { ...base, type: 'system', subtype: 'compact_boundary', uuid: 'cb', parentUuid: null, logicalParentUuid: 'c2' },
      user('c3', 'cb', 'summary of the earlier part', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
      user('c4', 'c3', 'second prompt'),
      assistant('c5', 'c4', [{ type: 'text', text: 'second answer' }]),
    ].map((l) => JSON.stringify(l));
    const out = claudeSessionToEvents(compacted);
    expect(out.turns).toBe(2);
    expect(JSON.stringify(out.events)).toContain('first answer');
    expect(JSON.stringify(out.events)).not.toContain('summary of the earlier part');
  });

  it('keeps every line when the parent chain breaks', () => {
    const broken = [
      user('b1', null, 'one'),
      user('b2', 'missing-parent', 'two'),
      assistant('b3', 'b2', [{ type: 'text', text: 'answer' }]),
    ].map((l) => JSON.stringify(l));
    expect(claudeSessionToEvents(broken).turns).toBe(2);
  });

  it('accepts one string and returns nothing for an empty file', () => {
    expect(claudeSessionToEvents(lines.join('\n')).turns).toBe(2);
    expect(claudeSessionToEvents('')).toEqual({ events: [], turns: 0 });
  });

  it('puts tool output before any prompt in turn 1', () => {
    const out = claudeSessionToEvents([JSON.stringify(assistant('o1', 'none', [{ type: 'text', text: 'hi' }]))]);
    expect(out.events.map((e) => e.turn)).toEqual([1]);
    expect(out.turns).toBe(0);
  });
});

describe('claudePromptText', () => {
  it.each([
    ['a typed string', { type: 'user', message: { content: 'hello' } }, 'hello'],
    ['text blocks', { type: 'user', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }, 'a\nb'],
    ['two images and no text', { type: 'user', message: { content: [{ type: 'image' }, { type: 'image' }] } }, '(2 images not shown.)'],
    ['a meta line', { type: 'user', isMeta: true, message: { content: 'x' } }, null],
    ['a sidechain line', { type: 'user', isSidechain: true, message: { content: 'x' } }, null],
    ['a compact summary', { type: 'user', isCompactSummary: true, message: { content: 'x' } }, null],
    ['a tool result', { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }, null],
    ['a slash command', { type: 'user', message: { content: '<command-name>/model</command-name>' } }, null],
    ['command output', { type: 'user', message: { content: '<local-command-stdout>ok</local-command-stdout>' } }, null],
    ['a bash escape', { type: 'user', message: { content: [{ type: 'text', text: '<bash-input>ls</bash-input>' }] } }, null],
    ['a task notification', { type: 'user', message: { content: '<task-notification>done</task-notification>' } }, null],
    ['blank text', { type: 'user', message: { content: '   ' } }, null],
    ['an assistant line', { type: 'assistant', message: { content: 'x' } }, null],
  ])('%s', (_label, line, expected) => {
    expect(claudePromptText(line)).toBe(expected);
  });
});

describe('claudeProjectSlug', () => {
  // Checked against real ~/.claude/projects folder names: `/` and `.` both become `-`.
  it.each([
    ['/Users/x/dev/a.b', '-Users-x-dev-a-b'],
    ['/Users/x/dev/fastowl/.claude/worktrees/tom-2', '-Users-x-dev-fastowl--claude-worktrees-tom-2'],
    ['/work/my_app', '-work-my-app'],
    ['/work/app', '-work-app'],
    ['C:\\Users\\x\\app', 'C--Users-x-app'],
  ])('%s → %s', (dir, slug) => {
    expect(claudeProjectSlug(dir)).toBe(slug);
  });
});

describe('isClaudeSessionId', () => {
  it.each([
    [SESSION, true],
    [SESSION.toUpperCase(), true],
    ['agent-1234', false],
    ['../etc/passwd', false],
    [`${SESSION}.jsonl`, false],
    [42, false],
  ])('%s → %s', (value, ok) => {
    expect(isClaudeSessionId(value)).toBe(ok);
  });
});
