import { beforeEach, describe, it, expect } from 'vitest';
import {
  buildBlocks,
  classifyShellCommand,
  describeTool,
  editDiffFromInput,
  effectiveToolError,
  isHiddenTool,
  summariseToolRun,
  toolRunFailures,
  formatToolOutput,
  groupToolRuns,
  groupedBlockSignature,
  mergeToolBlocks,
  mergedBlockSignature,
  type AgentEvent,
} from '@talyn/shared';

/**
 * The transcript block model, as the task terminal reads it.
 *
 * Three things are pinned here, all of which were visibly wrong on screen
 * before: assistant text appearing twice, a tool call and its output rendering
 * as two unrelated rows, and every fleet tool row reading `bash command=…` with
 * the command severed mid-word.
 */

let seq = 0;
function assistant(content: unknown[], id?: string): AgentEvent {
  return { seq: ++seq, type: 'assistant', message: { id, role: 'assistant', content } };
}
function toolResult(toolUseId: string, content: unknown, isError = false): AgentEvent {
  return {
    seq: ++seq,
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
    },
  };
}
function delta(text: string): AgentEvent {
  return {
    seq: ++seq,
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  };
}

/**
 * The duplication bug.
 *
 * The accumulator was cleared only when an `assistant` event's `message.id`
 * MATCHED the id captured at `message_start`. The fleet's guest converter emits
 * `id: msg.responseId ?? undefined`, and a provider sending deltas without a
 * `message_start` never sets the id at all — so it was never cleared, kept
 * every turn's text for the whole run, and rendered all of it concatenated as a
 * tail block. Each message appeared twice: once in place, once again run
 * together at the bottom.
 */
describe('streaming text', () => {
  it('does not repeat a finished turn as a tail block when ids are absent', () => {
    seq = 0;
    const blocks = buildBlocks([
      delta('Looking at the failing checks.'),
      assistant([{ type: 'text', text: 'Looking at the failing checks.' }]),
      delta('Need a deeper fetch.'),
      assistant([{ type: 'text', text: 'Need a deeper fetch.' }]),
    ]);

    const texts = blocks.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text);
    expect(texts).toEqual(['Looking at the failing checks.', 'Need a deeper fetch.']);
    // Specifically: nothing carrying BOTH turns run together.
    expect(texts.some((t) => t.includes('checks.Need'))).toBe(false);
  });

  it('still shows an in-flight turn that has no assistant event yet', () => {
    seq = 0;
    const blocks = buildBlocks([
      assistant([{ type: 'text', text: 'Done thinking.' }]),
      delta('Now I will '),
      delta('read the file.'),
    ]);
    const texts = blocks.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text);
    expect(texts).toEqual(['Done thinking.', 'Now I will read the file.']);
  });
});

/**
 * Tool names differ per provider and the renderer used to switch on Claude
 * Code's TitleCase set alone, so every fleet run (Pi's lowercase names) missed
 * every case and fell through to a `key=value` dump.
 */
describe('describeTool', () => {
  it.each([
    ['Bash', 'bash'],
    ['bash', 'bash'],
    ['shell', 'bash'],
    ['run_command', 'bash'],
    ['Read', 'read'],
    ['read_file', 'read'],
    ['str_replace_editor', 'edit'],
    ['MultiEdit', 'edit'],
    ['Grep', 'grep'],
    ['ripgrep', 'grep'],
    ['WebFetch', 'fetch'],
  ])('normalises %s to %s', (name, expected) => {
    expect(describeTool(name, {}).label).toBe(expected);
  });

  it('reads the command whatever the argument is called', () => {
    for (const key of ['command', 'cmd', 'script']) {
      const d = describeTool('bash', { [key]: 'git status' });
      expect(d.detail).toBe('git status');
      expect(d.isCommand).toBe(true);
    }
  });

  it('returns the command WHOLE — truncation is the renderer’s job', () => {
    const cmd = 'cd /work && rm -rf posthog && git clone --depth 1 https://github.com/PostHog/posthog';
    expect(describeTool('bash', { command: cmd }).detail).toBe(cmd);
  });

  it('flattens a multi-line command onto one line', () => {
    expect(describeTool('bash', { command: 'set -e\n\n  npm test\n' }).detail).toBe('set -e npm test');
  });

  it('keeps an unknown tool’s own name rather than guessing a verb', () => {
    const d = describeTool('mcp__linear__create_issue', { title: 'Fix the thing' });
    expect(d.label).toBe('mcp__linear__create_issue');
    // ...and still finds something readable to say about it.
    expect(d.detail).toBe('Fix the thing');
    expect(d.isCommand).toBe(false);
  });

  /**
   * MCP tools are commonly called with a single NUMERIC argument. Taking only
   * strings left those rows with no subject, so three tool calls naming three
   * different PRs rendered as three identical lines.
   */
  it('shows a scalar argument, not just a string one', () => {
    expect(describeTool('mcp__fleet__get_pull_request', { number: 73784 }).detail).toBe('73784');
    expect(describeTool('some_tool', { enabled: true }).detail).toBe('true');
  });

  it('says nothing rather than something wrong when there is no subject', () => {
    // An object argument inlines as `[object Object]`, which is worse than
    // silence at this size.
    expect(describeTool('TodoWrite', { todos: [1, 2] }).detail).toBe('');
  });
});

describe('mergeToolBlocks', () => {
  it('folds a result into the call that caused it', () => {
    seq = 0;
    const merged = mergeToolBlocks(
      buildBlocks([
        assistant([{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } }]),
        toolResult('t1', 'a.txt\nb.txt'),
      ])
    );

    expect(merged).toHaveLength(1);
    const tool = merged[0] as { kind: string; name: string; output: unknown; settled: boolean };
    expect(tool.kind).toBe('tool');
    expect(tool.name).toBe('bash');
    expect(tool.output).toBe('a.txt\nb.txt');
    expect(tool.settled).toBe(true);
  });

  it('leaves an in-flight call unsettled so the row can show it running', () => {
    seq = 0;
    const merged = mergeToolBlocks(
      buildBlocks([assistant([{ type: 'tool_use', id: 't1', name: 'bash', input: {} }])])
    );
    const tool = merged[0] as { settled: boolean; output: unknown };
    expect(tool.settled).toBe(false);
    expect(tool.output).toBeUndefined();
  });

  it('carries the error flag onto the CALL, not onto the output', () => {
    seq = 0;
    const merged = mergeToolBlocks(
      buildBlocks([
        assistant([{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'false' } }]),
        toolResult('t1', 'boom', true),
      ])
    );
    expect((merged[0] as { isError: boolean }).isError).toBe(true);
  });

  // A truncated transcript, or a run adopted mid-flight, can carry a result
  // whose call we never saw. Dropping it would silently lose output.
  it('keeps an orphan result rather than discarding it', () => {
    seq = 0;
    const merged = mergeToolBlocks(buildBlocks([toolResult('gone', 'output nobody asked for')]));
    expect(merged).toHaveLength(1);
    expect((merged[0] as { output: unknown }).output).toBe('output nobody asked for');
  });

  it('interleaves calls and prose in order', () => {
    seq = 0;
    const merged = mergeToolBlocks(
      buildBlocks([
        assistant([{ type: 'text', text: 'First I look.' }]),
        assistant([{ type: 'tool_use', id: 't1', name: 'read', input: { file_path: '/a.ts' } }]),
        toolResult('t1', 'contents'),
        assistant([{ type: 'text', text: 'Now I know.' }]),
      ])
    );
    expect(merged.map((b) => b.kind)).toEqual(['text', 'tool', 'text']);
  });

  /**
   * A tool block MUTATES when its result lands while keeping the key of the
   * call, so memoising on the key alone leaves every row spinning forever.
   */
  it('changes signature when a call settles', () => {
    seq = 0;
    const events = [assistant([{ type: 'tool_use', id: 't1', name: 'bash', input: {} }])];
    const before = mergedBlockSignature(mergeToolBlocks(buildBlocks(events))[0]);
    const after = mergedBlockSignature(
      mergeToolBlocks(buildBlocks([...events, toolResult('t1', 'done')]))[0]
    );
    expect(before).not.toBe(after);
  });
});

/**
 * How much of a tool's output goes on screen.
 *
 * The bug: the renderer clamped at six LINES, and a GitHub API response is
 * ~1.5 KB of minified JSON on ONE line. It sailed through the clamp and wrapped
 * to twenty rows of unreadable punctuation.
 */
describe('formatToolOutput', () => {
  const pr = JSON.stringify({
    url: 'https://api.github.com/repos/PostHog/posthog/pulls/95755',
    number: 95755,
    user: { login: 'Gilbert09', id: 1459269 },
  });

  it('measures characters as well as lines', () => {
    const out = formatToolOutput('x'.repeat(4000));
    expect(out.lines).toBe(1);
    // The measure the old clamp lacked, and the whole reason it did nothing.
    expect(out.chars).toBe(4000);
  });

  it('pretty-prints a JSON object so it can be read at all', () => {
    const out = formatToolOutput(pr);
    expect(out.isJson).toBe(true);
    expect(out.lines).toBeGreaterThan(1);
    expect(out.text).toContain('"number": 95755');
    expect(out.summary).toMatch(/^JSON · /);
  });

  it('leaves a scalar alone — pretty-printing it changes nothing', () => {
    for (const v of ['42', 'true', '"hello"']) {
      expect(formatToolOutput(v).isJson).toBe(false);
    }
  });

  it('leaves truncated JSON exactly as it came', () => {
    // A half-parsed document is worse than the raw bytes.
    const broken = '{"url":"https://api.github.com/repos/PostHog/pos';
    const out = formatToolOutput(broken);
    expect(out.isJson).toBe(false);
    expect(out.text).toBe(broken);
  });

  it('unwraps the [{type:text}] content shape a subagent returns', () => {
    const out = formatToolOutput([{ type: 'text', text: 'line one\nline two' }]);
    expect(out.text).toBe('line one\nline two');
    expect(out.lines).toBe(2);
  });

  it('says nothing about output that is not there', () => {
    expect(formatToolOutput(undefined).summary).toBe('');
    expect(formatToolOutput('').text).toBe('');
  });

  it('survives a cyclic object rather than throwing inside a render', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => formatToolOutput(cyclic)).not.toThrow();
  });
});

/**
 * An agent does several things to answer one sentence. Rendering each as a
 * top-level row buries the sentences that explain them.
 */
describe('groupToolRuns', () => {
  let s = 0;
  const use = (id: string, name: string, input: Record<string, unknown>): AgentEvent =>
    ({
      seq: ++s,
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    }) as AgentEvent;
  const res = (id: string, c: string, e = false): AgentEvent =>
    ({
      seq: ++s,
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: c, is_error: e }] },
    }) as AgentEvent;
  const say = (t: string): AgentEvent =>
    ({ seq: ++s, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } }) as AgentEvent;

  const grouped = (events: AgentEvent[]) => groupToolRuns(mergeToolBlocks(buildBlocks(events)));

  beforeEach(() => {
    s = 0;
  });

  it('folds consecutive calls into one section', () => {
    const out = grouped([
      use('a', 'bash', { command: 'make' }),
      res('a', 'ok'),
      use('b', 'bash', { command: 'pwd' }),
      res('b', '/work'),
      use('c', 'read', { file_path: '/a.ts' }),
      res('c', 'x'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('tool_group');
    expect((out[0] as { summary: string }).summary).toBe('Ran 2 commands, read a file');
  });

  /** Prose is the boundary a reader thinks in: "it said this, did these, said that". */
  it('breaks a run on prose', () => {
    const out = grouped([
      use('a', 'bash', { command: 'ls' }),
      res('a', 'ok'),
      say('Now the tests.'),
      use('b', 'bash', { command: 'pytest' }),
      res('b', 'ok'),
    ]);
    expect(out.map((b) => b.kind)).toEqual(['tool', 'text', 'tool']);
  });

  /** A lone call is not a "run"; hiding it costs a click to learn one line. */
  it('leaves a single call ungrouped', () => {
    const out = grouped([use('a', 'bash', { command: 'ls' }), res('a', 'ok')]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('tool');
  });

  it('reports a failure on the closed group, so it can open itself', () => {
    const out = grouped([
      use('a', 'bash', { command: 'ls' }),
      res('a', 'ok'),
      use('b', 'bash', { command: 'false' }),
      res('b', 'boom', true),
    ]);
    expect((out[0] as { isError: boolean }).isError).toBe(true);
  });

  it('reports a run as running while any call is in flight', () => {
    const out = grouped([
      use('a', 'bash', { command: 'ls' }),
      res('a', 'ok'),
      use('b', 'bash', { command: 'sleep 60' }),
    ]);
    expect((out[0] as { running: boolean }).running).toBe(true);
  });

  it('counts by canonical verb, not by tool name', () => {
    const out = grouped([
      use('a', 'Bash', { command: 'make' }),
      res('a', 'ok'),
      use('b', 'run_command', { cmd: 'pwd' }),
      res('b', 'ok'),
      use('c', 'shell', { script: 'id' }),
      res('c', 'ok'),
    ]);
    expect((out[0] as { summary: string }).summary).toBe('Ran 3 commands');
  });

  it('collapses unknown tools into one honest count', () => {
    const out = grouped([
      use('a', 'mcp__fleet__get_pull_request', { number: 1 }),
      res('a', '{}'),
      use('b', 'mcp__linear__create_issue', { title: 'x' }),
      res('b', '{}'),
    ]);
    expect((out[0] as { summary: string }).summary).toBe('2 tool calls');
  });

  /** A group mutates as its calls settle; memoising on the key alone would
   *  leave an open group frozen mid-run. */
  it('changes signature when a call inside settles', () => {
    const events = [use('a', 'bash', { command: 'ls' }), use('b', 'bash', { command: 'pwd' })];
    const before = groupedBlockSignature(grouped(events)[0]);
    s = 0;
    const after = groupedBlockSignature(grouped([...events, res('b', 'done')])[0]);
    expect(before).not.toBe(after);
  });
});

describe('system lines', () => {
  it.each([
    ['talyn_imported', 'Imported from a Claude Code conversation in /a.', { kind: 'system', text: 'Imported from a Claude Code conversation in /a.' }],
    ['sandbox_moved', 'Talyn moved this session to a Large · 12 GB sandbox.', { kind: 'system', text: 'Talyn moved this session to a Large · 12 GB sandbox.' }],
    ['sandbox_resize_failed', 'Talyn did not move this session.', { kind: 'system', text: 'Talyn did not move this session.' }],
    ['sandbox_restart_failed', 'Talyn did not restart this session.', { kind: 'system', text: 'Talyn did not restart this session.' }],
    ['sandbox_size_fallback', 'This session asks for more.', { kind: 'system', text: 'This session asks for more.' }],
    ['sandbox_low_disk', 'Less than 2 GB free.', { kind: 'system', text: 'Less than 2 GB free.' }],
    ['sandbox_processes_stopped', 'Start them again.', { kind: 'system', text: 'Start them again.' }],
    ['fleet_account_switched', 'Moved to "Teams".', { kind: 'system', text: 'Moved to "Teams".' }],
    ['local_turn_interrupted', 'The app quit during this turn.', { kind: 'system', text: 'The app quit during this turn.' }],
    ['agent_session_reset', 'Started a new session.', { kind: 'system', text: 'Started a new session.' }],
    ['stderr', 'boom', { kind: 'system', text: 'boom', subtype: 'stderr' }],
    ['init', 'hidden', null],
  ])('%s', (subtype, text, expected) => {
    const blocks = buildBlocks([{ seq: ++seq, type: 'system', subtype, text } as AgentEvent]);
    if (expected === null) expect(blocks).toEqual([]);
    else expect(blocks).toEqual([{ key: String(seq), ...expected }]);
  });
});

describe('talyn_memory events', () => {
  const memoryEvent = (fields: Record<string, unknown>) =>
    ({ seq: ++seq, type: 'talyn_memory', ...fields }) as AgentEvent;
  const change = { memoryId: 'm1', name: 'build command', memoryType: 'project', scope: 'repository' };

  it.each([
    ['created', 'Saved repository memory "build command"'],
    ['updated', 'Updated repository memory "build command"'],
    ['forgotten', 'Forgot repository memory "build command"'],
  ])('draws %s as a memory card line', (action, text) => {
    const blocks = buildBlocks([memoryEvent({ action, ...change })]);
    expect(blocks).toEqual([
      { kind: 'system', key: String(seq), subtype: 'talyn_memory', text, memory: { action, ...change } },
    ]);
  });

  it.each([
    ['an unknown action', { action: 'deleted', ...change }],
    ['no memory id', { action: 'created', ...change, memoryId: 7 }],
    ['an unknown type', { action: 'created', ...change, memoryType: 'note' }],
    ['an unknown scope', { action: 'created', ...change, scope: 'org' }],
  ])('drops an event with %s', (_label, fields) => {
    expect(buildBlocks([memoryEvent(fields)])).toEqual([]);
  });
});

describe('talyn_thread events', () => {
  const threadEvent = (fields: Record<string, unknown>) =>
    ({ seq: ++seq, type: 'talyn_thread', ...fields }) as AgentEvent;
  const child = { sessionId: 's1', name: 'fix-login', repo: 'acme/app' };

  it.each([
    ['session_started', 'idle', undefined, 'Session fix-login on acme/app started', {}],
    ['session_finished', 'idle', undefined, 'Session fix-login on acme/app finished its turn', {}],
    ['session_finished', 'error', undefined, 'Session fix-login on acme/app stopped with an error', { isError: true }],
    ['needs_input', 'awaiting_input', undefined, 'Session fix-login on acme/app needs an answer', {}],
    [
      'pr_opened', 'idle', 'https://github.com/acme/app/pull/7', 'Session fix-login on acme/app opened a pull request',
      { url: 'https://github.com/acme/app/pull/7' },
    ],
  ])('draws %s (%s) as a thread card line', (action, status, prUrl, text, extra) => {
    const fields = { action, status, ...child, ...(prUrl ? { prUrl } : {}) };
    expect(buildBlocks([threadEvent(fields)])).toEqual([
      { kind: 'system', key: String(seq), subtype: 'talyn_thread', text, thread: fields, ...extra },
    ]);
  });

  it.each([
    ['an unknown action', { action: 'deleted', status: 'idle', ...child }],
    ['no session id', { action: 'session_started', status: 'idle', ...child, sessionId: '' }],
  ])('drops an event with %s', (_label, fields) => {
    expect(buildBlocks([threadEvent(fields)])).toEqual([]);
  });
});

describe('Talyn messages', () => {
  const userMessage = (text: string, talyn: Record<string, unknown>) =>
    ({ seq: ++seq, type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, talyn }) as AgentEvent;

  it('draws a Talyn-origin message as a card, not a bubble', () => {
    const blocks = buildBlocks([userMessage('[Talyn] Session x finished its turn.', { kind: 'user_message', origin: 'talyn' })]);
    expect(blocks).toEqual([{ kind: 'system', key: String(seq), subtype: 'talyn_message', text: '[Talyn] Session x finished its turn.' }]);
  });

  it.each([
    ['a person', { kind: 'user_message' }],
    ['an explicit user origin', { kind: 'user_message', origin: 'user' }],
  ])('leaves a message from %s to the bubble', (_label, talyn) => {
    expect(buildBlocks([userMessage('hello', talyn)])).toEqual([]);
  });
});


describe('classifyShellCommand', () => {
  it.each([
    ["bash -lc 'rg -n foo src'", 'grep', 'foo'],
    ['/bin/zsh -lc "rg -n foo src"', 'grep', 'foo'],
    ["sh -c 'grep -rn needle .'", 'grep', 'needle'],
    ['zsh -lc "rg -e \'a b\' src"', 'grep', 'a b'],
    ['rg -e "foo.*bar" src', 'grep', 'foo.*bar'],
    ['rg --regexp=abc src', 'grep', 'abc'],
    ["rg -g '*.ts' -t ts needle src", 'grep', 'needle'],
    ["rg -A 3 needle", 'grep', 'needle'],
    ['grep -rn -- -weird src', 'grep', '-weird'],
    ["bash -lc \"sed -n '1,200p' src/a.ts\"", 'read', 'src/a.ts'],
    ["sed -n '10,20p' packages/x/b.ts", 'read', 'packages/x/b.ts'],
    ['cat README.md', 'read', 'README.md'],
    ['head -n 20 a.txt', 'read', 'a.txt'],
    ['tail -n 5 log.txt', 'read', 'log.txt'],
    ['nl -ba src/a.ts', 'read', 'src/a.ts'],
    ["bash -lc 'cd /work/repo && cat src/a.ts'", 'read', 'src/a.ts'],
    ["cd '/my dir' && rg foo", 'grep', 'foo'],
    ['ls', 'list', '.'],
    ['ls -la src', 'list', 'src'],
    ['find . -name "*.ts"', 'glob', '*.ts'],
    ['find . -name "*.tmp" -delete', 'bash', 'find . -name "*.tmp" -delete'],
    ['find . -type f -exec rm {} +', 'bash', 'find . -type f -exec rm {} +'],
    ['find src -type f', 'glob', 'src'],
    ['fd config', 'glob', 'config'],
    ['rg --files src', 'glob', 'src'],
    ["bash -lc \"bash -lc 'cat a.md'\"", 'read', 'a.md'],
  ])('classifies %s', (cmd, verb, detail) => {
    expect(classifyShellCommand(cmd)).toEqual({ verb, detail });
  });

  it.each([
    ['rg foo | head', 'rg foo | head'],
    ['cat a && cat b', 'cat a && cat b'],
    ['cat a; ls', 'cat a; ls'],
    ['cat a || true', 'cat a || true'],
    ['cat a > out.txt', 'cat a > out.txt'],
    ['cat < in.txt', 'cat < in.txt'],
    ['cat $(which x)', 'cat $(which x)'],
    ['cat `which x`', 'cat `which x`'],
    ['cat "$(which x)"', 'cat "$(which x)"'],
    ["bash -lc 'rg foo | head'", 'rg foo | head'],
    ["bash -lc 'npm test'", 'npm test'],
    ['npm test', 'npm test'],
    ["sed -i 's/a/b/' f.ts", "sed -i 's/a/b/' f.ts"],
    ["sed 's/a/b/' f.ts", "sed 's/a/b/' f.ts"],
    ['cat', 'cat'],
    ['rg', 'rg'],
    ['', ''],
    ["bash -lc 'unterminated", "bash -lc 'unterminated"],
  ])('keeps %j as bash', (cmd, detail) => {
    expect(classifyShellCommand(cmd)).toEqual({ verb: 'bash', detail });
  });

  it('describeTool classifies Bash at render time', () => {
    expect(describeTool('Bash', { command: "bash -lc 'rg -n foo'" })).toEqual({ label: 'grep', detail: 'foo', isCommand: false });
    expect(describeTool('Bash', { command: "bash -lc 'cat a.ts'" })).toEqual({ label: 'read', detail: 'a.ts', isCommand: false });
    expect(describeTool('Bash', { command: "bash -lc 'npm test'" })).toEqual({ label: 'bash', detail: 'npm test', isCommand: true });
  });

  it('describeTool knows NotebookEdit', () => {
    expect(describeTool('NotebookEdit', { notebook_path: '/a.ipynb', new_source: 'x' })).toMatchObject({ label: 'edit', detail: '/a.ipynb' });
  });
});

describe('tool runs: summaries, thinking, todos, failures', () => {
  let s = 0;
  const use = (id: string, name: string, input: Record<string, unknown>): AgentEvent =>
    ({ seq: ++s, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }) as AgentEvent;
  const res = (id: string, c: string, e = false): AgentEvent =>
    ({ seq: ++s, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: c, is_error: e }] } }) as AgentEvent;
  const think = (t: string): AgentEvent =>
    ({ seq: ++s, type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: t }] } }) as AgentEvent;
  const say = (t: string): AgentEvent =>
    ({ seq: ++s, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } }) as AgentEvent;
  const call = (id: string, command: string, out = 'ok', err = false) => [use(id, 'Bash', { command }), res(id, out, err)];
  const grouped = (events: AgentEvent[]) => groupToolRuns(mergeToolBlocks(buildBlocks(events)));
  const kinds = (events: AgentEvent[]) => grouped(events).map((b) => b.kind);

  beforeEach(() => {
    s = 0;
  });

  it('counts classified shell commands as reads and searches', () => {
    const out = grouped([
      ...call('a', "bash -lc 'rg foo'"),
      ...call('b', "bash -lc 'sed -n 1,5p a.ts'"),
      ...call('c', "bash -lc 'cat b.ts'"),
      ...call('d', 'npm test'),
    ]);
    expect((out[0] as { summary: string }).summary).toBe('Ran 1 command, read 2 files, 1 search');
  });

  it('summary never mentions failures', () => {
    const out = grouped([...call('a', 'false', 'boom', true), ...call('b', 'true')]);
    expect((out[0] as { summary: string }).summary).toBe('Ran 2 commands');
  });

  it('keeps thinking between calls inside the group, in order', () => {
    const out = grouped([...call('a', 'ls x'), think('hmm'), ...call('b', 'npm test')]);
    expect(out).toHaveLength(1);
    const g = out[0] as { tools: unknown[]; children: { kind: string }[] };
    expect(g.tools).toHaveLength(2);
    expect(g.children.map((c) => c.kind)).toEqual(['tool', 'thinking', 'tool']);
  });

  it('leaves thinking at the edges of a run outside it', () => {
    const out = grouped([think('first'), ...call('a', 'npm a'), ...call('b', 'npm b'), think('last')]);
    expect(out.map((b) => b.kind)).toEqual(['thinking', 'tool_group', 'thinking']);
    expect((out[1] as { children: unknown[] }).children).toHaveLength(2);
  });

  it('thinking next to a single call stays outside', () => {
    expect(kinds([...call('a', 'npm a'), think('x')])).toEqual(['tool', 'thinking']);
  });

  it('text still ends a run, thinking before the text stays outside', () => {
    expect(kinds([...call('a', 'npm a'), think('x'), say('hi'), ...call('b', 'npm b')])).toEqual(['tool', 'thinking', 'text', 'tool']);
  });

  it('hides todo tools', () => {
    expect(isHiddenTool('TodoWrite')).toBe(true);
    expect(isHiddenTool('Bash')).toBe(false);
    expect(kinds([use('t', 'TodoWrite', { todos: [] }), res('t', 'ok')])).toEqual([]);
    const out = grouped([...call('a', 'npm a'), use('t', 'TodoWrite', { todos: [] }), res('t', 'ok'), ...call('b', 'npm b')]);
    expect(out).toHaveLength(1);
    expect((out[0] as { tools: unknown[] }).tools).toHaveLength(2);
  });

  it('reports failedCount and lastFailed', () => {
    const out = grouped([...call('a', 'x', 'boom', true), ...call('b', 'y'), ...call('c', 'z', 'bad', true)]);
    expect(out[0]).toMatchObject({ failedCount: 2, lastFailed: true });
    const out2 = grouped([...call('a', 'x', 'boom', true), ...call('b', 'y')]);
    expect(out2[0]).toMatchObject({ failedCount: 1, lastFailed: false });
    expect(toolRunFailures([])).toEqual({ failedCount: 0, lastFailed: false });
  });

  it.each([
    ['Bash', "bash -lc 'rg nothing'", '', true, false],
    ['Bash', "rg nothing", '  \n', true, false],
    ['Bash', "rg nothing", 'rg: bad regex', true, true],
    ['Bash', "npm test", '', true, true],
    ['Bash', "rg nothing", '', false, false],
    ['Grep', '', '', true, true],
  ])('effectiveToolError(%s, %j, %j, %s) = %s', (name, command, output, isError, expected) => {
    expect(effectiveToolError(name, { command }, output, isError)).toBe(expected);
  });

  it('a shell search with no matches merges as not failed', () => {
    const out = grouped([...call('a', "bash -lc 'rg zzz'", '', true), ...call('b', 'cat a.ts')]);
    expect((out[0] as { isError: boolean }).isError).toBe(false);
  });

  it('summariseToolRun accepts plain tool blocks', () => {
    const blocks = mergeToolBlocks(buildBlocks([...call('a', 'cat x.ts')])).filter((b) => b.kind === 'tool');
    expect(summariseToolRun(blocks as never)).toBe('Read a file');
  });
});

describe('editDiffFromInput', () => {
  it('diffs an Edit with context and counts', () => {
    const d = editDiffFromInput('Edit', { file_path: '/a.ts', old_string: 'a\nb\nc\nd\ne\nf\ng', new_string: 'a\nb\nc\nD\ne\nf\ng' });
    expect(d).toEqual({
      path: '/a.ts',
      added: 1,
      removed: 1,
      lines: [
        { kind: 'ctx', text: 'b' },
        { kind: 'ctx', text: 'c' },
        { kind: 'del', text: 'd' },
        { kind: 'add', text: 'D' },
        { kind: 'ctx', text: 'e' },
        { kind: 'ctx', text: 'f' },
      ],
    });
  });

  it('handles insert and delete', () => {
    expect(editDiffFromInput('Edit', { file_path: 'a', old_string: '', new_string: 'x\ny\n' })).toMatchObject({ added: 2, removed: 0 });
    expect(editDiffFromInput('Edit', { file_path: 'a', old_string: 'x\ny', new_string: '' })).toMatchObject({ added: 0, removed: 2 });
  });

  it('diffs a changed block with an LCS, keeping unchanged inner lines as context', () => {
    const d = editDiffFromInput('Edit', { file_path: 'a', old_string: 'a\nkeep\nb', new_string: 'x\nkeep\ny' });
    expect(d?.lines.map((l) => `${l.kind}:${l.text}`)).toEqual(['del:a', 'add:x', 'ctx:keep', 'del:b', 'add:y']);
  });

  it('MultiEdit separates edits with a hunk line', () => {
    const d = editDiffFromInput('MultiEdit', {
      file_path: 'a',
      edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }, { nope: 1 }],
    });
    expect(d?.lines.map((l) => l.kind)).toEqual(['del', 'add', 'hunk', 'del', 'add']);
    expect(d).toMatchObject({ added: 2, removed: 2 });
  });

  it('Write is all additions', () => {
    expect(editDiffFromInput('Write', { file_path: 'n.ts', content: 'a\nb\n' })).toEqual({
      path: 'n.ts', added: 2, removed: 0, lines: [{ kind: 'add', text: 'a' }, { kind: 'add', text: 'b' }],
    });
  });

  it('NotebookEdit uses notebook_path and new_source', () => {
    expect(editDiffFromInput('NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'x=1' })).toMatchObject({ path: 'n.ipynb', added: 1 });
  });

  it('identical strings give an empty diff', () => {
    expect(editDiffFromInput('Edit', { file_path: 'a', old_string: 'same', new_string: 'same' })).toEqual({ path: 'a', added: 0, removed: 0, lines: [] });
  });

  it.each([
    ['Edit', { file_path: 'a', changes: [{ path: 'a', kind: 'update' }] }],
    ['Edit', { file_path: 'a', kind: 'update' }],
    ['Edit', { old_string: 'a', new_string: 'b' }],
    ['Edit', null],
    ['Edit', 'str'],
    ['Bash', { file_path: 'a', old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: 'a', edits: [] }],
    ['MultiEdit', { file_path: 'a' }],
    ['Write', { file_path: 'a' }],
    ['NotebookEdit', { notebook_path: 'a' }],
  ])('returns null for %s %j', (name, input) => {
    expect(editDiffFromInput(name, input)).toBeNull();
  });

  it('falls back to all-del then all-add for huge inputs', () => {
    const old = Array.from({ length: 600 }, (_, i) => `o${i}`).join('\n');
    const neu = Array.from({ length: 600 }, (_, i) => `n${i}`).join('\n');
    const d = editDiffFromInput('Edit', { file_path: 'a', old_string: old, new_string: neu });
    expect(d).toMatchObject({ added: 600, removed: 600 });
    expect(d?.lines.slice(0, 600).every((l) => l.kind === 'del')).toBe(true);
    expect(d?.lines.slice(600).every((l) => l.kind === 'add')).toBe(true);
  });
});
