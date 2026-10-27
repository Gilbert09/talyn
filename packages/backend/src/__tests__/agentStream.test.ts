import { describe, it, expect } from 'vitest';
import {
  CLAUDE_DEFAULT_CONTEXT_WINDOW,
  CODEX_DEFAULT_CONTEXT_WINDOW,
  LineBuffer,
  buildBlocks,
  buildClaudeArgv,
  buildCodexArgv,
  codexReasoningEffort,
  createAgentStreamParser,
  createClaudeStreamParser,
  createCodexStreamParser,
  mergeToolBlocks,
  parseAgentLine,
  withSeq,
  type AgentEventDraft,
  type AgentStreamParser,
  type ClaudeArgvOptions,
  type CodexArgvOptions,
  type WorkbenchEffort,
} from '@talyn/shared';

const feed = (parser: AgentStreamParser, lines: unknown[]): AgentEventDraft[] =>
  lines.flatMap((l) => parser.push(typeof l === 'string' ? l : JSON.stringify(l)));
const sequence = (drafts: AgentEventDraft[]) => drafts.map((d, i) => withSeq(d, i + 1));

// ============================================================================
// argv
// ============================================================================

describe('buildClaudeArgv', () => {
  const head = ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

  it.each<[string, ClaudeArgvOptions, string[]]>([
    ['minimal', { prompt: 'hi' }, [...head, '--permission-mode', 'bypassPermissions', '--', 'hi']],
    [
      'model + effort',
      { prompt: 'hi', model: 'claude-opus-4-8', effort: 'high' },
      [...head, '--model', 'claude-opus-4-8', '--permission-mode', 'bypassPermissions', '--effort', 'high', '--', 'hi'],
    ],
    ['plan mode wins over permissionMode', { prompt: 'p', planMode: true, permissionMode: 'acceptEdits' }, [...head, '--permission-mode', 'plan', '--', 'p']],
    ['explicit permission mode', { prompt: 'p', permissionMode: 'acceptEdits' }, [...head, '--permission-mode', 'acceptEdits', '--', 'p']],
    ['resume', { prompt: 'p', resumeSessionId: 'sess-1' }, [...head, '--permission-mode', 'bypassPermissions', '--resume', 'sess-1', '--', 'p']],
    [
      'resume + fork',
      { prompt: 'p', resumeSessionId: 's', forkSession: true },
      [...head, '--permission-mode', 'bypassPermissions', '--resume', 's', '--fork-session', '--', 'p'],
    ],
    ['fork without resume is dropped', { prompt: 'p', forkSession: true }, [...head, '--permission-mode', 'bypassPermissions', '--', 'p']],
    [
      'append system prompt',
      { prompt: 'p', appendSystemPrompt: 'be brief' },
      [...head, '--permission-mode', 'bypassPermissions', '--append-system-prompt', 'be brief', '--', 'p'],
    ],
    ['custom binary', { prompt: 'p', binary: '/opt/claude' }, ['/opt/claude', ...head.slice(1), '--permission-mode', 'bypassPermissions', '--', 'p']],
    ['prompt starting with a dash stays a prompt', { prompt: '--help me' }, [...head, '--permission-mode', 'bypassPermissions', '--', '--help me']],
  ])('%s', (_name, opts, expected) => {
    expect(buildClaudeArgv(opts)).toEqual(expected);
  });

  it('only passes --effort when one is given', () => {
    expect(buildClaudeArgv({ prompt: 'x' })).not.toContain('--effort');
  });

  it('puts the prompt last, after --', () => {
    const argv = buildClaudeArgv({ prompt: 'the prompt', model: 'm', resumeSessionId: 's', effort: 'max' });
    expect(argv.slice(-2)).toEqual(['--', 'the prompt']);
  });
});

describe('buildCodexArgv', () => {
  const flags = (sandbox: string, network = sandbox === 'workspace-write') => [
    '-c',
    `sandbox_mode="${sandbox}"`,
    '-c',
    'approval_policy="never"',
    ...(network ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
  ];

  it.each<[string, CodexArgvOptions, string[]]>([
    ['first turn', { prompt: 'hi' }, ['codex', 'exec', '--json', '--skip-git-repo-check', ...flags('workspace-write'), '--', 'hi']],
    ['plan mode is read-only, no network', { prompt: 'hi', planMode: true }, ['codex', 'exec', '--json', '--skip-git-repo-check', ...flags('read-only'), '--', 'hi']],
    [
      'model + effort',
      { prompt: 'hi', model: 'gpt-5.5-codex', effort: 'high' },
      ['codex', 'exec', '--json', '--skip-git-repo-check', '-m', 'gpt-5.5-codex', '-c', 'model_reasoning_effort="high"', ...flags('workspace-write'), '--', 'hi'],
    ],
    [
      'follow-up resumes the thread',
      { prompt: 'more', resumeSessionId: 'thread-1' },
      ['codex', 'exec', 'resume', '--json', '--skip-git-repo-check', ...flags('workspace-write'), '--', 'thread-1', 'more'],
    ],
    [
      'sandbox override',
      { prompt: 'x', sandboxMode: 'danger-full-access' },
      ['codex', 'exec', '--json', '--skip-git-repo-check', ...flags('danger-full-access'), '--', 'x'],
    ],
    [
      'images',
      { prompt: 'x', images: ['/a.png', '/b.png'] },
      ['codex', 'exec', '--json', '--skip-git-repo-check', ...flags('workspace-write'), '-i', '/a.png', '-i', '/b.png', '--', 'x'],
    ],
  ])('%s', (_name, opts, expected) => {
    expect(buildCodexArgv(opts)).toEqual(expected);
  });

  it.each<[CodexArgvOptions]>([[{ prompt: 'x' }], [{ prompt: 'x', resumeSessionId: 's', planMode: true }], [{ prompt: 'x', sandboxMode: 'danger-full-access' }]])(
    'never bypasses approvals: %j',
    (opts) => {
      const argv = buildCodexArgv(opts);
      expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(argv).not.toContain('--full-auto');
      // `exec resume` has no --sandbox flag, so it must never be used.
      expect(argv).not.toContain('--sandbox');
    }
  );

  it.each<[WorkbenchEffort, string]>([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
    ['max', 'xhigh'],
  ])('effort %s → %s', (effort, expected) => {
    expect(codexReasoningEffort(effort)).toBe(expected);
  });
});

// ============================================================================
// LineBuffer
// ============================================================================

describe('LineBuffer', () => {
  it.each<[string, string[], string[], string[]]>([
    ['one whole line', ['a\n'], ['a'], []],
    ['split mid-line', ['{"a"', ':1}\n'], ['{"a":1}'], []],
    ['several lines in one chunk', ['a\nb\nc\n'], ['a', 'b', 'c'], []],
    ['trailing partial kept for flush', ['a\nb'], ['a'], ['b']],
    ['CRLF stripped', ['a\r\nb\r\n'], ['a', 'b'], []],
    ['CR split from LF across chunks', ['a\r', '\nb'], ['a'], ['b']],
    ['empty lines kept', ['\n\n'], ['', ''], []],
    ['byte at a time', 'xy\nz'.split(''), ['xy'], ['z']],
    ['nothing', [], [], []],
    ['unterminated CR tail', ['abc\r'], [], ['abc']],
  ])('%s', (_name, chunks, lines, rest) => {
    const buf = new LineBuffer();
    const got = chunks.flatMap((c) => buf.push(c));
    expect(got).toEqual(lines);
    expect(buf.flush()).toEqual(rest);
    expect(buf.flush()).toEqual([]);
  });
});

// ============================================================================
// Claude
// ============================================================================

const SESSION = '8f6c3a2e-1d2b-4c5d-9e8f-0a1b2c3d4e5f';
const claudeInit = {
  type: 'system',
  subtype: 'init',
  cwd: '/work/repo',
  session_id: SESSION,
  tools: ['Bash', 'Read', 'Edit', 'TodoWrite'],
  model: 'claude-opus-4-8',
  permissionMode: 'bypassPermissions',
  apiKeySource: 'none',
};
const claudeStream = [
  claudeInit,
  {
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } },
    session_id: SESSION,
    parent_tool_use_id: null,
    uuid: 'u1',
  },
  {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me ' } },
    session_id: SESSION,
    parent_tool_use_id: null,
  },
  {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'plan.' } },
    session_id: SESSION,
    parent_tool_use_id: null,
  },
  {
    type: 'assistant',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-8',
      content: [
        { type: 'text', text: 'Let me plan.' },
        {
          type: 'tool_use',
          id: 'toolu_todo',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
              { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
              { content: 'Run tests', status: 'pending', activeForm: 'Running tests' },
            ],
          },
        },
      ],
      usage: { input_tokens: 12, cache_creation_input_tokens: 3000, cache_read_input_tokens: 15000, output_tokens: 80 },
    },
    parent_tool_use_id: null,
    session_id: SESSION,
  },
  {
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_todo', type: 'tool_result', content: 'Todos have been modified successfully.' }] },
    parent_tool_use_id: null,
    session_id: SESSION,
  },
  {
    type: 'assistant',
    message: {
      id: 'msg_2',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }],
      usage: { input_tokens: 5, cache_creation_input_tokens: 200, cache_read_input_tokens: 18000, output_tokens: 30 },
    },
    parent_tool_use_id: null,
    session_id: SESSION,
  },
  {
    // A subagent's message: its own context, must not move the gauge.
    type: 'assistant',
    message: {
      id: 'msg_sub',
      role: 'assistant',
      content: [{ type: 'text', text: 'subagent says hi' }],
      usage: { input_tokens: 999999, output_tokens: 1 },
    },
    parent_tool_use_id: 'toolu_task',
    session_id: SESSION,
  },
  {
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_bash', type: 'tool_result', content: '3 passing', is_error: false }] },
    parent_tool_use_id: null,
    session_id: SESSION,
  },
  {
    type: 'assistant',
    message: { id: 'msg_3', role: 'assistant', content: [{ type: 'text', text: 'All green.' }] },
    parent_tool_use_id: null,
    session_id: SESSION,
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 12345,
    duration_api_ms: 10000,
    num_turns: 4,
    result: 'All green.',
    session_id: SESSION,
    total_cost_usd: 0.4321,
    usage: { input_tokens: 17, cache_creation_input_tokens: 3200, cache_read_input_tokens: 33000, output_tokens: 110 },
    modelUsage: {
      'claude-haiku-4-5': { inputTokens: 10, outputTokens: 5, contextWindow: 200000, costUSD: 0.001 },
      'claude-opus-4-8': { inputTokens: 17, outputTokens: 110, contextWindow: 1000000, costUSD: 0.43 },
    },
    permission_denials: [],
  },
];

describe('createClaudeStreamParser', () => {
  it('passes every JSON event through unchanged', () => {
    const parser = createClaudeStreamParser();
    const out = feed(parser, claudeStream);
    expect(out).toEqual(claudeStream);
  });

  it('derives session id, todos, context usage and the result', () => {
    const parser = createClaudeStreamParser();
    expect(parser.sessionId).toBeNull();
    expect(parser.contextUsage).toBeNull();
    feed(parser, claudeStream);
    expect(parser.sessionId).toBe(SESSION);
    expect(parser.todos).toEqual([
      { content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
      { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
      { content: 'Run tests', status: 'pending', activeForm: 'Running tests' },
    ]);
    // Last top-level assistant WITH usage: 5 + 200 + 18000. The subagent is ignored,
    // and the last message without usage does not reset it.
    expect(parser.contextUsage).toEqual({ usedTokens: 18205, contextWindow: 1_000_000, windowKnown: true, fraction: 0.018205 });
    expect(parser.result).toEqual({
      isError: false,
      subtype: 'success',
      text: 'All green.',
      costUsd: 0.4321,
      durationMs: 12345,
      numTurns: 4,
    });
  });

  it('renders through buildBlocks as text, tool calls, results and a result card', () => {
    const blocks = buildBlocks(sequence(feed(createClaudeStreamParser(), claudeStream)));
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'tool_use', 'tool_result', 'tool_use', 'text', 'tool_result', 'text', 'result']);
    const merged = mergeToolBlocks(blocks);
    const bash = merged.find((b) => b.kind === 'tool' && b.name === 'Bash');
    expect(bash).toMatchObject({ settled: true, output: '3 passing', isError: false });
  });

  it.each<[string, Record<string, unknown>, number, boolean]>([
    ['the main model when modelUsage names it', { 'claude-opus-4-8': { contextWindow: 500000 }, other: { contextWindow: 900000 } }, 500000, true],
    ['the largest window otherwise', { a: { contextWindow: 100000 }, b: { contextWindow: 300000 } }, 300000, true],
    ['the default when none is given', { a: {} }, CLAUDE_DEFAULT_CONTEXT_WINDOW, false],
  ])('context window: %s', (_name, modelUsage, expected, known) => {
    const parser = createClaudeStreamParser();
    feed(parser, [
      claudeInit,
      { type: 'assistant', message: { content: [], usage: { input_tokens: 100 } }, session_id: SESSION },
      { type: 'result', subtype: 'success', result: '', modelUsage },
    ]);
    expect(parser.contextUsage?.contextWindow).toBe(expected);
    expect(parser.contextUsage?.windowKnown).toBe(known);
  });

  it('marks the default window unknown until the result reports it', () => {
    const parser = createClaudeStreamParser();
    feed(parser, [
      claudeInit,
      { type: 'assistant', message: { content: [], usage: { input_tokens: 140_000 } } },
    ]);
    expect(parser.model).toBe('claude-opus-4-8');
    expect(parser.contextUsage).toEqual({ usedTokens: 140_000, contextWindow: 200_000, windowKnown: false, fraction: 0.7 });
    feed(parser, [{ type: 'result', subtype: 'success', result: '', modelUsage: { 'claude-opus-4-8': { contextWindow: 1_000_000 } } }]);
    expect(parser.contextUsage).toEqual({ usedTokens: 140_000, contextWindow: 1_000_000, windowKnown: true, fraction: 0.14 });
  });

  it('a [1m] model defaults to a 1M window before the result arrives', () => {
    const parser = createClaudeStreamParser();
    feed(parser, [
      { ...claudeInit, model: 'claude-opus-4-8[1m]' },
      { type: 'assistant', message: { content: [], usage: { input_tokens: 500000 } } },
    ]);
    expect(parser.contextUsage).toEqual({ usedTokens: 500000, contextWindow: 1_000_000, windowKnown: true, fraction: 0.5 });
  });

  it('clamps the fraction to 1', () => {
    const parser = createClaudeStreamParser();
    feed(parser, [{ type: 'assistant', message: { content: [], usage: { input_tokens: 300000 } } }]);
    expect(parser.contextUsage?.fraction).toBe(1);
  });

  it.each([
    ['error subtype', { type: 'result', subtype: 'error_max_turns', is_error: false, result: '' }, true],
    ['is_error flag', { type: 'result', subtype: 'success', is_error: true, result: 'API Error' }, true],
    ['success', { type: 'result', subtype: 'success', is_error: false, result: 'ok' }, false],
  ])('result: %s', (_name, event, isError) => {
    const parser = createClaudeStreamParser();
    feed(parser, [event]);
    expect(parser.result?.isError).toBe(isError);
  });

  it('takes the LATEST TodoWrite and normalises bad entries', () => {
    const parser = createClaudeStreamParser();
    const todo = (todos: unknown) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'TodoWrite', input: { todos } }] } });
    feed(parser, [
      todo([{ content: 'old', status: 'pending' }]),
      todo([{ content: 'new', status: 'weird' }, { nope: true }, 'string', { content: 'done', status: 'completed' }]),
      todo('not an array'),
    ]);
    expect(parser.todos).toEqual([
      { content: 'new', status: 'pending' },
      { content: 'done', status: 'completed' },
    ]);
  });

  it.each([
    ['plain text', 'Warning: something odd', 1],
    ['a JSON array', '[1,2]', 1],
    ['a JSON string', '"x"', 1],
    ['an object with no type', '{"a":1}', 1],
    ['truncated JSON', '{"type":"assistant"', 1],
    ['a blank line', '   ', 0],
  ])('drops %s and counts it', (_name, line, count) => {
    const parser = createClaudeStreamParser();
    expect(parser.push(line)).toEqual([]);
    expect(parser.nonJsonLines).toBe(count);
  });

  it('works through a LineBuffer with arbitrary chunking', () => {
    const text = claudeStream.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const buf = new LineBuffer();
    const parser = createClaudeStreamParser();
    const out: AgentEventDraft[] = [];
    for (let i = 0; i < text.length; i += 37) {
      for (const line of buf.push(text.slice(i, i + 37))) out.push(...parser.push(line));
    }
    for (const line of buf.flush()) out.push(...parser.push(line));
    expect(out).toEqual(claudeStream);
    expect(parser.nonJsonLines).toBe(0);
  });
});

// ============================================================================
// Codex
// ============================================================================

const THREAD = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const codexStream = [
  { type: 'thread.started', thread_id: THREAD },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Exploring the repo**\n\nI should list files.' } },
  { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: "bash -lc 'ls -la'", aggregated_output: '', exit_code: null, status: 'in_progress' } },
  {
    type: 'item.completed',
    item: { id: 'item_1', type: 'command_execution', command: "bash -lc 'ls -la'", aggregated_output: 'README.md\nsrc\n', exit_code: 0, status: 'completed' },
  },
  {
    type: 'item.started',
    item: { id: 'item_2', type: 'todo_list', items: [{ text: 'Find the bug', completed: false }, { text: 'Fix it', completed: false }] },
  },
  { type: 'item.started', item: { id: 'item_3', type: 'command_execution', command: 'npm test', aggregated_output: '', exit_code: null, status: 'in_progress' } },
  {
    type: 'item.completed',
    item: { id: 'item_3', type: 'command_execution', command: 'npm test', aggregated_output: '1 failing\n', exit_code: 1, status: 'failed' },
  },
  {
    type: 'item.completed',
    item: { id: 'item_4', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'src/new.ts', kind: 'add' }], status: 'completed' },
  },
  {
    type: 'item.updated',
    item: { id: 'item_2', type: 'todo_list', items: [{ text: 'Find the bug', completed: true }, { text: 'Fix it', completed: false }] },
  },
  {
    type: 'item.started',
    item: { id: 'item_5', type: 'mcp_tool_call', server: 'linear', tool: 'get_issue', arguments: { id: 'ENG-1' }, result: null, error: null, status: 'in_progress' },
  },
  {
    type: 'item.completed',
    item: {
      id: 'item_5',
      type: 'mcp_tool_call',
      server: 'linear',
      tool: 'get_issue',
      arguments: { id: 'ENG-1' },
      result: { content: [{ type: 'text', text: 'Issue ENG-1' }], structured_content: null },
      error: null,
      status: 'completed',
    },
  },
  { type: 'item.completed', item: { id: 'item_6', type: 'web_search', query: 'vitest each' } },
  { type: 'item.updated', item: { id: 'item_7', type: 'agent_message', text: 'Fixed ' } },
  { type: 'item.updated', item: { id: 'item_7', type: 'agent_message', text: 'Fixed the bug' } },
  { type: 'item.completed', item: { id: 'item_7', type: 'agent_message', text: 'Fixed the bug in src/a.ts.' } },
  { type: 'turn.completed', usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122 } },
];

describe('createCodexStreamParser', () => {
  it('derives the session id from thread.started and the result from turn.completed', () => {
    const parser = createCodexStreamParser();
    feed(parser, codexStream);
    expect(parser.sessionId).toBe(THREAD);
    expect(parser.result).toEqual({ isError: false, subtype: 'success', text: 'Fixed the bug in src/a.ts.' });
    expect(parser.contextUsage).toEqual({
      usedTokens: 24763,
      contextWindow: CODEX_DEFAULT_CONTEXT_WINDOW,
      windowKnown: false,
      fraction: 24763 / CODEX_DEFAULT_CONTEXT_WINDOW,
    });
    expect(parser.todos).toEqual([
      { content: 'Find the bug', status: 'completed' },
      { content: 'Fix it', status: 'in_progress' },
    ]);
    expect(parser.nonJsonLines).toBe(0);
  });

  it('stamps every event with the thread id as session_id', () => {
    const out = feed(createCodexStreamParser(), codexStream);
    expect(out.every((e) => e.session_id === THREAD)).toBe(true);
  });

  it('renders through buildBlocks as thinking, paired tool calls, text and a result', () => {
    const blocks = buildBlocks(sequence(feed(createCodexStreamParser(), codexStream)));
    expect(blocks.map((b) => (b.kind === 'tool_use' ? `tool_use:${b.name}` : b.kind))).toEqual([
      'thinking',
      'tool_use:Bash',
      'tool_result',
      'tool_use:TodoWrite',
      'tool_result',
      'tool_use:Bash',
      'tool_result',
      'tool_use:Edit',
      'tool_result',
      'tool_use:TodoWrite',
      'tool_result',
      'tool_use:mcp__linear__get_issue',
      'tool_result',
      'tool_use:WebSearch',
      'tool_result',
      'text',
      'result',
    ]);

    const merged = mergeToolBlocks(blocks);
    const tools = merged.filter((b) => b.kind === 'tool');
    expect(tools.every((t) => t.kind === 'tool' && t.settled)).toBe(true);
    expect(tools[0]).toMatchObject({ name: 'Bash', input: { command: "bash -lc 'ls -la'" }, output: 'README.md\nsrc\n', isError: false });
    expect(tools.find((t) => t.kind === 'tool' && t.toolId === 'item_3')).toMatchObject({ isError: true, output: '1 failing\n' });
    expect(tools.find((t) => t.kind === 'tool' && t.name === 'Edit')).toMatchObject({
      input: { file_path: 'src/a.ts, src/new.ts' },
      output: 'M src/a.ts\nA src/new.ts',
    });
    expect(tools.find((t) => t.kind === 'tool' && t.name.startsWith('mcp__'))).toMatchObject({
      input: { id: 'ENG-1' },
      output: [{ type: 'text', text: 'Issue ENG-1' }],
    });

    const text = blocks.find((b) => b.kind === 'text');
    expect(text).toMatchObject({ text: 'Fixed the bug in src/a.ts.' });
    const result = blocks[blocks.length - 1];
    expect(result).toMatchObject({ kind: 'result', summary: 'Fixed the bug in src/a.ts.', inputTokens: 24763, outputTokens: 122, isError: false });
    // The streamed tail is gone once the message completed.
    expect(blocks.filter((b) => b.kind === 'text')).toHaveLength(1);
  });

  it('shows streaming agent text as a live tail before the message completes', () => {
    const upToStreaming = codexStream.slice(0, codexStream.findIndex((e) => e.type === 'item.completed' && e.item?.id === 'item_7'));
    const blocks = buildBlocks(sequence(feed(createCodexStreamParser(), upToStreaming)));
    const tail = blocks[blocks.length - 1];
    expect(tail).toMatchObject({ kind: 'text', text: 'Fixed the bug' });
  });

  it('a running command renders as an unsettled tool call', () => {
    const blocks = buildBlocks(sequence(feed(createCodexStreamParser(), codexStream.slice(0, 4))));
    const merged = mergeToolBlocks(blocks);
    expect(merged[merged.length - 1]).toMatchObject({ kind: 'tool', name: 'Bash', settled: false });
  });

  it('does not emit a todo tool call when the list did not change', () => {
    const parser = createCodexStreamParser();
    const todo = { type: 'item.updated', item: { id: 't', type: 'todo_list', items: [{ text: 'a', completed: false }] } };
    expect(feed(parser, [todo])).toHaveLength(2);
    expect(feed(parser, [todo])).toHaveLength(0);
  });

  it('emits a tool call only once even if completion arrives without a start', () => {
    const out = feed(createCodexStreamParser(), [
      { type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'ls', aggregated_output: 'x', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'ls', aggregated_output: 'x', exit_code: 0, status: 'completed' } },
    ]);
    expect(out.map((e) => e.type)).toEqual(['assistant', 'user']);
  });

  it.each([
    ['mcp error', { id: 'm', type: 'mcp_tool_call', server: 's', tool: 't', arguments: {}, result: null, error: { message: 'boom' }, status: 'failed' }, 'boom', true],
    ['failed file change', { id: 'f', type: 'file_change', changes: [{ path: 'x', kind: 'delete' }], status: 'failed' }, 'D x', true],
    ['command with no exit code yet but failed status', { id: 'c', type: 'command_execution', command: 'x', aggregated_output: '', exit_code: null, status: 'failed' }, '', true],
  ])('tool result: %s', (_name, item, content, isError) => {
    const out = feed(createCodexStreamParser(), [{ type: 'item.completed', item }]);
    const result = out[out.length - 1];
    expect((result.message?.content as Array<{ content: unknown; is_error: boolean }>)[0]).toMatchObject({ content, is_error: isError });
  });

  it('turn.failed is an error result', () => {
    const parser = createCodexStreamParser();
    const out = feed(parser, [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.failed', error: { message: 'usage limit reached' } }]);
    expect(parser.result).toEqual({ isError: true, subtype: 'error_during_execution', text: 'usage limit reached' });
    const blocks = buildBlocks(sequence(out));
    expect(blocks[blocks.length - 1]).toMatchObject({ kind: 'result', isError: true, summary: 'usage limit reached' });
  });

  it.each([
    ['top-level error (e.g. a reconnect notice)', { type: 'error', message: 'Reconnecting... 1/5' }, 'Reconnecting... 1/5'],
    ['error item', { type: 'item.completed', item: { id: 'e', type: 'error', message: 'command timed out' } }, 'command timed out'],
  ])('%s renders as a stderr system block and is not fatal', (_name, event, text) => {
    const parser = createCodexStreamParser();
    const blocks = buildBlocks(sequence(feed(parser, [event])));
    expect(blocks).toEqual([{ kind: 'system', key: '1', text, subtype: 'stderr' }]);
    expect(parser.result).toBeNull();
  });

  it('accepts the older assistant_message item type', () => {
    const blocks = buildBlocks(sequence(feed(createCodexStreamParser(), [{ type: 'item.completed', item: { id: 'a', type: 'assistant_message', text: 'hi' } }])));
    expect(blocks).toEqual([{ kind: 'text', key: '1.0', text: 'hi' }]);
  });

  it('ignores unknown events and item types, and counts non-JSON lines', () => {
    const parser = createCodexStreamParser();
    expect(feed(parser, [{ type: 'turn.started' }, { type: 'something.new' }, { type: 'item.completed', item: { id: 'x', type: 'future_item' } }])).toEqual([]);
    expect(parser.push('Reading prompt from stdin...')).toEqual([]);
    expect(parser.nonJsonLines).toBe(1);
  });

  it('honours a custom context window', () => {
    const parser = createCodexStreamParser({ contextWindow: 100_000 });
    feed(parser, [{ type: 'turn.completed', usage: { input_tokens: 50_000, output_tokens: 1 } }]);
    expect(parser.contextUsage).toEqual({ usedTokens: 50_000, contextWindow: 100_000, windowKnown: true, fraction: 0.5 });
  });
});

describe('createAgentStreamParser / parseAgentLine', () => {
  it.each([['claude'], ['codex']] as const)('%s', (agent) => {
    const parser = createAgentStreamParser(agent);
    expect(parser.agent).toBe(agent);
    const line = agent === 'claude' ? JSON.stringify(claudeInit) : JSON.stringify({ type: 'thread.started', thread_id: 'x' });
    expect(parseAgentLine(agent, parser, line)).toHaveLength(1);
  });

  it('refuses to feed one agent’s output to the other’s parser', () => {
    expect(() => parseAgentLine('codex', createClaudeStreamParser(), '{}')).toThrow(/claude parser/);
  });

  it('withSeq stamps a sequence number', () => {
    expect(withSeq({ type: 'system', subtype: 'init' }, 7)).toEqual({ type: 'system', subtype: 'init', seq: 7 });
  });
});


describe('parser snapshots', () => {
  it.each(['claude', 'codex'] as const)('continues %s without replaying the saved prefix', (agent) => {
    const prefix = agent === 'codex' ? [
      { type: 'thread.started', thread_id: 'session' },
      { type: 'item.started', item: { id: 'tool', type: 'command_execution', command: 'ls' } },
      { type: 'item.updated', item: { id: 'text', type: 'agent_message', text: 'hello' } },
    ] : [{ type: 'system', subtype: 'init', session_id: 'session', model: 'claude' }];
    const suffix = agent === 'codex' ? [
      { type: 'item.completed', item: { id: 'tool', type: 'command_execution', command: 'ls', aggregated_output: 'file' } },
      { type: 'item.updated', item: { id: 'text', type: 'agent_message', text: 'hello world' } },
      { type: 'item.completed', item: { id: 'text', type: 'agent_message', text: 'hello world' } },
      { type: 'turn.completed', usage: { input_tokens: 42 } },
    ] : [{ type: 'result', subtype: 'success', result: 'done' }];
    const original = createAgentStreamParser(agent);
    prefix.forEach((line) => original.push(JSON.stringify(line)));
    const resumed = createAgentStreamParser(agent, JSON.parse(JSON.stringify(original.snapshot())));
    const actual = suffix.flatMap((line) => resumed.push(JSON.stringify(line)));
    const expected = suffix.flatMap((line) => original.push(JSON.stringify(line)));
    expect(actual).toEqual(expected);
    expect(resumed.snapshot()).toEqual(original.snapshot());
  });
});
