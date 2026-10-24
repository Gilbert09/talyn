/** @jest-environment node */
import type { CoderPreviewInput } from '../workbenchBridgeTypes';
import { CoderPreviews } from '../main/workbench/coderPreview';

const base = 'a'.repeat(40);
const input: CoderPreviewInput = {
  sessionId: 's1', repoName: 'PostHog/posthog', base,
  config: { target: 'coder', ports: [{ port: 8010, primary: true }], coder: { url: 'https://coder.example', run: 'npm run dev' }, reasons: [], source: 'user' },
};
function setup() {
  const cli = {
    status: jest.fn().mockResolvedValue({ installed: true, loggedIn: true, user: 'tom' }),
    workspaces: jest.fn().mockResolvedValue([{ name: 'dev', owner: 'tom', status: 'stopped', template: 'linux' }]),
    start: jest.fn().mockResolvedValue(undefined),
    exec: jest.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
    appUrls: jest.fn().mockResolvedValue([]),
    portForward: jest.fn().mockResolvedValue('http://localhost:8010'),
    stopForwards: jest.fn(),
  };
  const open = jest.fn().mockResolvedValue(undefined);
  return { cli, open, previews: new CoderPreviews(cli, open) };
}
async function ready(previews: CoderPreviews, id = 's1') {
  await previews.prepare({ ...input, sessionId: id });
  await previews.sync({ sessionId: id, base, patch: 'patch\n', turn: 4 });
}

it('checks the CLI, starts the workspace, and creates the worktree once', async () => {
  const { cli, previews } = setup();
  await previews.prepare(input);
  await previews.prepare(input);
  expect(cli.exec).toHaveBeenCalledTimes(1);
  const script = cli.exec.mock.calls[0][1];
  expect(script).toContain('if [ ! -e "$HOME"/\'.talyn/previews/s1\' ]');
  expect(script).toContain(`git -C "$HOME"/'posthog' fetch --quiet origin && git -C "$HOME"/'posthog' worktree add --force --detach`);
  expect(script).toContain(base);
  expect(cli.status.mock.invocationCallOrder[0]).toBeLessThan(cli.start.mock.invocationCallOrder[0]);
  expect(cli.start.mock.invocationCallOrder[0]).toBeLessThan(cli.exec.mock.invocationCallOrder[0]);
});
it.each(['patch with binary data\n', ''])('syncs %j through stdin', async (patch) => {
  const { cli, previews } = setup();
  await previews.prepare(input);
  const state = await previews.sync({ sessionId: 's1', base, patch, turn: 4 });
  expect(cli.exec).toHaveBeenLastCalledWith('dev', expect.stringContaining(`git reset --hard ${base} && git clean -fdq`), { input: patch || undefined });
  expect(cli.exec.mock.calls.at(-1)![1].includes('git apply --binary --whitespace=nowarn')).toBe(Boolean(patch));
  expect(state).toMatchObject({ turn: 4, syncedAt: expect.any(String) });
});
it('stops the previous session before starting another on the same workspace', async () => {
  const { cli, previews } = setup();
  await ready(previews);
  await previews.run('s1');
  cli.exec.mockClear();
  await ready(previews, 's2');
  await previews.run('s2');
  const commands = cli.exec.mock.calls.map((call) => call[1] as string);
  const kill = commands.findIndex((command) => command.includes("tmux kill-session -t '=talyn-preview-s1'"));
  const run = commands.findIndex((command) => command.includes("tmux new-session -d -s 'talyn-preview-s2'"));
  expect(kill).toBeGreaterThanOrEqual(0);
  expect(kill).toBeLessThan(run);
  expect(previews.state('s1')).toMatchObject({ active: false, running: false });
  await expect(previews.sync({ sessionId: 's1', base, patch: '' })).rejects.toThrow('stopped');
});
it('serializes two starts on the same workspace', async () => {
  const { previews } = setup();
  await Promise.all([previews.prepare(input), previews.prepare({ ...input, sessionId: 's2' })]);
  expect(previews.state('s1')?.active).toBe(false);
  expect(previews.state('s2')?.active).toBe(true);
});
it('stops tmux, the fallback process group, and forwarding without removing the worktree', async () => {
  const { cli, previews } = setup();
  await ready(previews);
  await previews.run('s1');
  cli.exec.mockClear();
  await previews.stop('s1');
  expect(cli.exec.mock.calls[0][1]).toContain("tmux kill-session -t '=talyn-preview-s1'");
  expect(cli.exec.mock.calls[0][1]).toContain('kill -- "-$p"');
  expect(cli.exec.mock.calls[0][1]).not.toContain('worktree remove');
  expect(cli.stopForwards).toHaveBeenCalledWith('dev');
  expect(previews.state('s1')).toMatchObject({ running: false, active: false, worktreeReady: true });
});
it('removes only the session worktree on request', async () => {
  const { cli, previews } = setup();
  await ready(previews);
  await previews.remove('s1');
  expect(cli.exec).toHaveBeenLastCalledWith('dev', `git -C "$HOME"/'posthog' worktree remove --force "$HOME"/'.talyn/previews/s1'`, { input: undefined });
  expect(previews.state('s1')).toBeNull();
});
it('reads the default run script from the synced worktree', async () => {
  const { cli, previews } = setup();
  await previews.prepare({ ...input, config: { ...input.config, coder: { url: 'https://coder.example' } } });
  await previews.sync({ sessionId: 's1', base, patch: '' });
  cli.exec.mockResolvedValueOnce({ code: 0, stdout: '[scripts]\nrun = "npm run dev"', stderr: '' });
  await previews.run('s1');
  expect(cli.exec.mock.calls.at(-1)![1]).toContain('npm run dev');
  expect(cli.exec.mock.calls.at(-1)![1]).toContain('nohup');
});
it('asks for a run command when none exists', async () => {
  const { previews } = setup();
  await previews.prepare({ ...input, config: { ...input.config, coder: { url: 'https://coder.example' } } });
  await previews.sync({ sessionId: 's1', base, patch: '' });
  await expect(previews.run('s1')).rejects.toThrow('Set the Coder run command');
});
it('opens the primary app URL, then falls back to a port forward', async () => {
  const { cli, open, previews } = setup();
  await ready(previews);
  cli.appUrls.mockResolvedValueOnce([{ slug: 'other', port: 3000, url: 'https://other.example' }, { slug: 'app', port: 8010, url: 'https://app.example' }]);
  await previews.open('s1');
  expect(open).toHaveBeenLastCalledWith('https://app.example');
  expect(cli.portForward).not.toHaveBeenCalled();
  await previews.open('s1');
  expect(cli.portForward).toHaveBeenCalledWith('dev', 8010);
  expect(open).toHaveBeenLastCalledWith('http://localhost:8010');
});
it.each([
  [{ installed: false, loggedIn: false }, 'brew install coder/coder/coder'],
  [{ installed: true, loggedIn: false }, 'coder login https://coder.example'],
])('shows the repair command for %j', async (status, command) => {
  const { cli, previews } = setup();
  cli.status.mockResolvedValue(status);
  await expect(previews.prepare(input)).rejects.toThrow(command);
  expect(cli.exec).not.toHaveBeenCalled();
});
it.each([
  { sessionId: '../escape' }, { base: 'HEAD; id' },
  { config: { ...input.config, coder: { url: 'https://coder.example', checkout: '~/bad\npath' } } },
])('rejects unsafe inputs: %j', async (override) => {
  const { cli, previews } = setup();
  await expect(async () => previews.prepare({ ...input, ...override })).rejects.toThrow();
  expect(cli.exec).not.toHaveBeenCalled();
});
it('does not mark a failed patch as synced', async () => {
  const { cli, previews } = setup();
  await ready(previews);
  cli.exec.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'patch failed' });
  await expect(previews.sync({ sessionId: 's1', base, patch: 'broken' })).rejects.toThrow('patch failed');
  expect(previews.state('s1')?.syncedAt).toBeUndefined();
});
