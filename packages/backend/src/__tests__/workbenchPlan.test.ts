import { describe, expect, it } from 'vitest';
import {
  buildClaudeArgv,
  findTurnPlan,
  parsePlanBlock,
  stripPlanBlocks,
  workbenchTurnPrompt,
  type AgentEvent,
} from '@talyn/shared';

const fence = (body: string, ticks = '```') => `${ticks}talyn-plan\n${body}\n${ticks}`;

describe('parsePlanBlock', () => {
  it.each<[string, string, string | null]>([
    ['a block after prose', `Here is the plan.\n\n${fence('1. Add it.\n2. Test it.')}`, '1. Add it.\n2. Test it.'],
    ['trailing spaces on the opener', '```talyn-plan   \n- Do it.\n```', '- Do it.'],
    ['a tilde fence', fence('- Do it.', '~~~'), '- Do it.'],
    ['a four-tick fence holding a code block', fence('Run:\n```sh\nnpm test\n```\nDone.', '````'), 'Run:\n```sh\nnpm test\n```\nDone.'],
    ['an unclosed block runs to the end', 'Plan:\n```talyn-plan\n1. Start.\n2. Finish.', '1. Start.\n2. Finish.'],
    ['the last of two blocks wins', `${fence('old')}\n\n${fence('new')}`, 'new'],
    ['an empty last block falls back to the one before', `${fence('real')}\n${fence('')}`, 'real'],
    ['no block', 'Which database do you use?', null],
    ['another language', '```json\n{}\n```', null],
    ['the fence name inside prose', 'I will write a talyn-plan block next.', null],
  ])('%s', (_, text, expected) => {
    expect(parsePlanBlock(text)).toBe(expected);
  });
});

describe('stripPlanBlocks', () => {
  it.each<[string, string, string]>([
    ['keeps the prose and drops the block', `Here is the plan.\n\n${fence('1. Add it.')}`, 'Here is the plan.'],
    ['keeps text after the block', `Before.\n${fence('x')}\nAfter.`, 'Before.\nAfter.'],
    ['drops an unclosed block to the end', 'Plan:\n```talyn-plan\n1. Start.', 'Plan:'],
    ['leaves other code blocks', 'Run:\n```sh\nnpm test\n```', 'Run:\n```sh\nnpm test\n```'],
    ['a reply that is only the block', fence('x'), ''],
  ])('%s', (_, text, expected) => {
    expect(stripPlanBlocks(text)).toBe(expected);
  });
});

describe('findTurnPlan', () => {
  const assistant = (...content: unknown[]): AgentEvent =>
    ({ seq: 1, type: 'assistant', message: { role: 'assistant', content } }) as unknown as AgentEvent;
  const text = (t: string) => ({ type: 'text', text: t });
  const write = (file_path: string, content: string) => ({ type: 'tool_use', id: 't1', name: 'Write', input: { file_path, content } });

  it('reads the block from the last text that has one', () => {
    expect(findTurnPlan([assistant(text(fence('first'))), assistant(text('Thinking more.')), assistant(text(fence('second')))])).toBe(
      'second',
    );
  });

  it('prefers a block over the plan file', () => {
    const events = [assistant(write('/home/fleet/.claude/plans/x.md', 'from file')), assistant(text(fence('from block')))];
    expect(findTurnPlan(events)).toBe('from block');
  });

  it('falls back to the plan file Claude wrote', () => {
    const events = [assistant(write('/Users/me/.claude/plans/plan-silly-horizon.md', '1. Do it.\n')), assistant(text('Approve?'))];
    expect(findTurnPlan(events)).toBe('1. Do it.');
  });

  it.each<[string, AgentEvent[]]>([
    ['a question and no plan', [assistant(text('Which table holds the users?'))]],
    ['a write to any other file', [assistant(write('/repo/PLAN.md', '1. Do it.'))]],
    ['a user event', [{ seq: 1, type: 'user', message: { role: 'user', content: [text(fence('x'))] } } as unknown as AgentEvent]],
    ['no events', []],
  ])('null for %s', (_, events) => {
    expect(findTurnPlan(events)).toBeNull();
  });
});

describe('workbenchTurnPrompt', () => {
  const createPr = { branch: 'tom/x', baseBranch: 'main' };

  it('adds nothing to an ordinary turn', () => {
    expect(workbenchTurnPrompt({ agent: 'claude', text: 'hi', planMode: false, createPr })).toEqual({ prompt: 'hi' });
    expect(workbenchTurnPrompt({ agent: 'codex', text: 'hi', planMode: false, createPr })).toEqual({ prompt: 'hi' });
  });

  it.each(['claude', 'codex'] as const)('tells %s about limited access only when it is off', (agent) => {
    const off = workbenchTurnPrompt({ agent, text: 'hi', planMode: false, createPr, internetAccess: false });
    const on = workbenchTurnPrompt({ agent, text: 'hi', planMode: false, createPr, internetAccess: true });
    expect(off.appendSystemPrompt ?? off.prompt).toContain('the package registries (npm, PyPI, apt), and the agent API');
    expect(on).toEqual({ prompt: 'hi' });
  });

  it('Claude in plan mode: the plan instructions are an appended system prompt', () => {
    const turn = workbenchTurnPrompt({ agent: 'claude', text: 'Plan the change', planMode: true, createPr });
    expect(turn.prompt).toBe('Plan the change');
    expect(turn.appendSystemPrompt).toContain('```talyn-plan');
    const argv = buildClaudeArgv({ prompt: turn.prompt, planMode: true, appendSystemPrompt: turn.appendSystemPrompt });
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('plan');
  });

  it('Codex in plan mode: the plan instructions go in front of the text', () => {
    const turn = workbenchTurnPrompt({ agent: 'codex', text: 'Plan the change', planMode: true, createPr });
    expect(turn.appendSystemPrompt).toBeUndefined();
    expect(turn.prompt).toContain('```talyn-plan');
    expect(turn.prompt.endsWith('Plan the change')).toBe(true);
  });

  it('a Create PR turn gets the PR instructions, not the plan ones', () => {
    const turn = workbenchTurnPrompt({ agent: 'claude', text: 'Create a pull request', planMode: true, intent: 'create_pr', createPr });
    expect(turn.appendSystemPrompt).toContain('talyn-pr');
    expect(turn.appendSystemPrompt).not.toContain('talyn-plan');
    expect(turn.prompt).toContain('talyn-pr');
    expect(turn.prompt).not.toContain('talyn-plan');
  });
});
