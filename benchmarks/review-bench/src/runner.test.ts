import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexRunner, readSettings, type AgentUnit } from './main.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(), mkdtemp: vi.fn(async () => '/mock/unit'), readFile: vi.fn(),
  realpath: vi.fn(), rename: vi.fn(), rm: vi.fn(), writeFile: vi.fn(),
}));

const unit: AgentUnit = {
  name: 'lens-correctness-1', kind: 'lens', lens: 'correctness', model: 'test-model', prompt: 'Private prompt text.',
};

function childProcess() {
  const stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const child = Object.assign(new EventEmitter(), { pid: 12345, stdin, stderr, stdout, kill: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

describe('Codex process adapter with a mocked process', () => {
  beforeEach(() => {
    vi.mocked(readFile).mockResolvedValue('Final message.');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('writes the prompt to stdin and captures the final message and stderr', async () => {
    vi.stubEnv('RB_MODEL_BASE_URL', 'https://models.example.test/v1');
    const child = childProcess();
    child.stdin.end.mockImplementation(() => {
      child.stderr.emit('data', 'Diagnostic output.');
      child.emit('close', 0, null);
    });
    const result = await codexRunner(readSettings({ RB_CONFIG_EFFORT: 'high' }), '/repo', '/debug')(unit);
    expect(result).toBe('Final message.');
    const [command, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(command).toBe('codex');
    expect(args).toEqual([
      'exec', '--model', 'test-model', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check',
      '--color', 'never', '--json', '-o', '/mock/unit/last-message.txt',
      '-c', 'approval_policy="never"', '-c', 'features.apps=false',
      '-c', 'web_search="disabled"', '-c', 'tools.web_search=false',
      '-c', 'model_reasoning_effort="high"',
    ]);
    expect(options).toMatchObject({ cwd: '/repo', detached: true, env: { OPENAI_BASE_URL: 'https://models.example.test/v1' } });
    expect(child.stdin.end).toHaveBeenCalledWith(unit.prompt);
    expect(writeFile).toHaveBeenCalledWith('/debug/lens-correctness-1.txt', expect.stringContaining('Diagnostic output.'));
    expect(rm).toHaveBeenCalledWith('/mock/unit', { recursive: true, force: true });
  });

  it.each([1, 137])('rejects exit code %s even when a final message exists', async (code) => {
    const child = childProcess();
    child.stdin.end.mockImplementation(() => child.emit('close', code, null));
    await expect(codexRunner(readSettings({}))(unit)).rejects.toThrow(`code ${code}`);
    expect(writeFile).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('Final message.'));
  });

  it('kills the process group on timeout and saves diagnostics', async () => {
    vi.useFakeTimers();
    const child = childProcess();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      child.emit('close', null, 'SIGKILL');
      return true;
    });
    const result = codexRunner(readSettings({ RB_CONFIG_UNIT_TIMEOUT_SEC: '2' }))(unit);
    const assertion = expect(result).rejects.toThrow('timed out after 2 seconds');
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
    expect(writeFile).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('timed out'));
  });

  it('records a spawn error and cleans up when no final message exists', async () => {
    const child = childProcess();
    vi.mocked(readFile).mockRejectedValueOnce(new Error('Missing file.'));
    child.stdin.end.mockImplementation(() => child.emit('error', new Error('spawn ENOENT')));
    await expect(codexRunner(readSettings({}))(unit)).rejects.toThrow('spawn ENOENT');
    expect(writeFile).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('spawn ENOENT'));
    expect(rm).toHaveBeenCalled();
  });

  it('retains complete diagnostics', async () => {
    const child = childProcess();
    child.stdin.end.mockImplementation(() => {
      child.stderr.emit('data', 'x'.repeat(20_000) + 'last');
      child.emit('close', 0, null);
    });
    await codexRunner(readSettings({}))(unit);
    expect(writeFile).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('x'.repeat(20_000) + 'last'));
  });

  it.each(['stderr', 'stdout', 'final'])('rejects a shell environment failure in %s', async (source) => {
    const child = childProcess();
    const error = 'bwrap: No permissions to create a new namespace';
    if (source === 'final') vi.mocked(readFile).mockResolvedValue(error);
    child.stdin.end.mockImplementation(() => {
      if (source === 'stderr') {
        child.stderr.emit('data', error.slice(0, 3));
        child.stderr.emit('data', error.slice(3) + '\n' + 'x'.repeat(20_000));
      }
      if (source === 'stdout') child.stdout.emit('data', JSON.stringify({
        type: 'item.completed', item: { type: 'command_execution', exit_code: 1, aggregated_output: error },
      }) + '\n');
      child.emit('close', 0, null);
    });
    await expect(codexRunner(readSettings({}))(unit)).rejects.toThrow('Shell environment failed');
    expect(writeFile).toHaveBeenCalledWith(expect.any(String), expect.stringContaining(error));
  });
});
