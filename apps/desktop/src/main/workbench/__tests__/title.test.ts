/** @jest-environment node */
import * as environment from '../environment';
import { generateWorkbenchTitle, runTitleCommand, type TitleRunner } from '../title';

beforeEach(() => {
  jest.spyOn(environment, 'processEnv').mockResolvedValue({ ...process.env });
});

afterEach(() => {
  jest.restoreAllMocks();
});

const runner =
  (result: Partial<Awaited<ReturnType<TitleRunner>>>): TitleRunner =>
  async () => ({ exitCode: 0, stdout: '', timedOut: false, ...result });

describe('generateWorkbenchTitle', () => {
  it('runs the cheap model with the first message and cleans the answer', async () => {
    const run = jest.fn(runner({ stdout: '"Explain the Merge Queue."\n' }));
    const title = await generateWorkbenchTitle({ agent: 'claude', message: 'explain how the merge queue works' }, run, 1000);
    expect(title).toBe('Explain the Merge Queue');
    const [argv, timeoutMs] = run.mock.calls[0];
    expect(argv.slice(0, 6)).toEqual(['claude', '-p', '--output-format', 'text', '--model', 'haiku']);
    expect(argv[argv.length - 1]).toContain('explain how the merge queue works');
    expect(timeoutMs).toBe(1000);
  });

  it('runs codex for a codex chat', async () => {
    const run = jest.fn(runner({ stdout: 'Explain merge queue' }));
    await generateWorkbenchTitle({ agent: 'codex', message: 'explain it' }, run);
    expect(run.mock.calls[0][0].slice(0, 3)).toEqual(['codex', 'exec', '--ephemeral']);
    expect(run.mock.calls[0][0]).toContain('gpt-6-luna');
  });

  it.each([
    ['a timeout', runner({ timedOut: true, exitCode: null, stdout: 'Half a tit' })],
    ['a non-zero exit', runner({ exitCode: 1, stdout: 'Explain Merge Queue' })],
    ['a missing CLI', runner({ exitCode: null })],
    ['empty output', runner({ stdout: '' })],
    ['multi-line output', runner({ stdout: 'Sure! Here is a title:\nExplain Merge Queue' })],
    ['a runner that throws', (async () => { throw new Error('spawn failed'); }) as TitleRunner],
  ])('answers null on %s', async (_label, run) => {
    expect(await generateWorkbenchTitle({ agent: 'claude', message: 'explain it' }, run)).toBeNull();
  });

  it.each([
    [{ agent: 'claude' as const, message: '   ' }],
    [{ agent: 'gemini' as never, message: 'explain it' }],
  ])('makes no call for %j', async (input) => {
    const run = jest.fn(runner({ stdout: 'x' }));
    expect(await generateWorkbenchTitle(input, run)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('runTitleCommand', () => {
  it('returns the output and the exit code', async () => {
    const result = await runTitleCommand([process.execPath, '-e', 'process.stdout.write("Fix login\\n")'], 5000);
    expect(result).toEqual({ exitCode: 0, stdout: 'Fix login\n', timedOut: false });
  });

  it('closes stdin, so a CLI that reads it does not wait', async () => {
    const script = 'let n=0;process.stdin.on("data",d=>n+=d.length);process.stdin.on("end",()=>process.stdout.write(String(n)))';
    const result = await runTitleCommand([process.execPath, '-e', script], 5000);
    expect(result).toEqual({ exitCode: 0, stdout: '0', timedOut: false });
  });

  it('kills a call that runs past the timeout', async () => {
    const result = await runTitleCommand([process.execPath, '-e', 'setTimeout(() => {}, 10000)'], 100);
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
  });

  it('answers a missing binary with no exit code', async () => {
    const result = await runTitleCommand(['talyn-no-such-cli-for-tests'], 5000);
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
  });
});
