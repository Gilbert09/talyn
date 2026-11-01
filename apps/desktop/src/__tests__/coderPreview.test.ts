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
    waitUntilRunning: jest.fn().mockResolvedValue(undefined),
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
  [{ installed: false, loggedIn: false }, process.platform === 'win32' ? 'winget install Coder.Coder' : 'brew install coder/coder/coder'],
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

const checkInput = { sessionId: 's1', repoName: input.repoName, config: input.config };
const hogliConfig = { ...input.config, reasons: ['Found coder_url in hogli.yaml.'] };
const install = process.platform === 'win32' ? 'winget install Coder.Coder' : 'brew install coder/coder/coder';
const commands = (state: { problem?: { commands?: { command: string }[] } } | null) => state?.problem?.commands?.map((item) => item.command);

it.each([
  [{ installed: false, loggedIn: false, problem: 'not_installed' }, false, 'not_installed', 'cli', [install]],
  [{ installed: false, loggedIn: false, problem: 'not_installed' }, true, 'not_installed', 'cli', [install, 'hogli devbox:setup']],
  [{ installed: true, loggedIn: false, problem: 'not_logged_in' }, false, 'not_logged_in', 'login', ['coder login https://coder.example']],
  [{ installed: true, loggedIn: false, problem: 'not_logged_in' }, true, 'not_logged_in', 'login', ['coder login https://coder.example', 'hogli devbox:setup']],
  [{ installed: true, loggedIn: false, problem: 'wrong_deployment', url: 'https://other.example' }, false, 'wrong_deployment', 'login', ['coder login https://coder.example']],
  [{ installed: true, loggedIn: false, problem: 'unreachable', detail: 'dial tcp: i/o timeout' }, false, 'unreachable', 'login', undefined],
  [{ installed: true, loggedIn: false, problem: 'unreachable', detail: 'dial tcp: i/o timeout' }, true, 'unreachable', 'login', ['hogli devbox:doctor']],
])('a check reports %j (hogli=%s) as a problem, not an error', async (status, hogli, code, step, fix) => {
  const { cli, previews } = setup();
  cli.status.mockResolvedValue(status);
  const state = await previews.check({ ...checkInput, config: hogli ? hogliConfig : input.config });
  expect(state.problem).toMatchObject({ code, step });
  expect(commands(state)).toEqual(fix);
  expect(state.error).toContain(state.problem!.message);
  expect(state).toMatchObject({ cliReady: status.installed, signedIn: false, workspaceRunning: false });
  expect(cli.workspaces).not.toHaveBeenCalled();
  expect(cli.exec).not.toHaveBeenCalled();
});
it('names the official install script only as text', async () => {
  const { cli, previews } = setup();
  cli.status.mockResolvedValue({ installed: false, loggedIn: false });
  const state = await previews.check(checkInput);
  expect(state.problem?.note).toContain('curl -L https://coder.com/install.sh | sh');
  expect(commands(state)).not.toContain('curl -L https://coder.com/install.sh | sh');
});
it('says the deployment is unreachable, not that the sign-in failed', async () => {
  const { cli, previews } = setup();
  cli.status.mockResolvedValue({ installed: true, loggedIn: false, problem: 'unreachable', detail: 'no such host' });
  const state = await previews.check(checkInput);
  expect(state.problem?.message).toContain('cannot reach https://coder.example');
  expect(state.problem?.detail).toBe('no such host');
});
it('reports a stopped workspace and offers to start it without starting it', async () => {
  const { cli, previews } = setup();
  const state = await previews.check(checkInput);
  expect(state).toMatchObject({ cliReady: true, signedIn: true, workspaceRunning: false, workspace: 'dev' });
  expect(state.problem).toMatchObject({ code: 'workspace_stopped', step: 'workspace', action: 'start_workspace' });
  expect(commands(state)).toEqual(['coder start dev']);
  expect(cli.start).not.toHaveBeenCalled();
});
it('starts the workspace on request and shows its status while it starts', async () => {
  const { cli, previews } = setup();
  await previews.check(checkInput);
  let release!: () => void;
  cli.start.mockImplementation(async (_name: string, onStatus: (status: string) => void) => {
    onStatus('starting');
    await new Promise<void>((resolve) => { release = resolve; });
  });
  const started = previews.startWorkspace('s1');
  await new Promise((resolve) => setImmediate(resolve));
  expect(previews.state('s1')).toMatchObject({ step: 'workspace', stepDetail: 'Starting dev. Status: starting' });
  release();
  expect(await started).toMatchObject({ workspaceRunning: true });
  expect(previews.state('s1')).toMatchObject({ workspaceRunning: true, step: undefined, problem: undefined });
  expect(cli.start).toHaveBeenCalledWith('dev', expect.any(Function));
});
it('waits for a workspace that is already starting', async () => {
  const { cli, previews } = setup();
  cli.workspaces.mockResolvedValue([{ name: 'dev', owner: 'tom', status: 'starting', template: 'linux' }]);
  const state = await previews.check(checkInput);
  expect(state.workspaceRunning).toBe(true);
  expect(state.problem).toBeUndefined();
  expect(cli.waitUntilRunning).toHaveBeenCalledWith('dev', expect.any(Number), expect.any(Function));
});
it('asks the person to wait for a workspace that is stopping', async () => {
  const { cli, previews } = setup();
  cli.workspaces.mockResolvedValue([{ name: 'dev', owner: 'tom', status: 'stopping', template: 'linux' }]);
  expect((await previews.check(checkInput)).problem).toMatchObject({ code: 'workspace_busy', message: expect.stringContaining('stopping') });
});
it('tells a network failure of coder list apart from other failures', async () => {
  const { cli, previews } = setup();
  cli.workspaces.mockRejectedValue(new Error('coder list failed.\ndial tcp: lookup coder.example: no such host'));
  expect((await previews.check(checkInput)).problem).toMatchObject({ code: 'unreachable', step: 'workspace', detail: expect.stringContaining('no such host') });
  cli.workspaces.mockRejectedValue(new Error('permission denied'));
  expect((await previews.check(checkInput)).problem).toMatchObject({ code: 'error', step: 'workspace', detail: 'permission denied' });
});
it('records the failed step of a preview that throws', async () => {
  const { cli, previews } = setup();
  cli.exec.mockResolvedValueOnce({ code: 128, stdout: '', stderr: 'fatal: not a git repository' });
  await expect(previews.prepare(input)).rejects.toThrow('not a git repository');
  expect(previews.state('s1')).toMatchObject({ workspaceRunning: true, worktreeReady: false, step: undefined, problem: { step: 'worktree', code: 'error' } });
});
it('gives the worktree step a longer timeout for a large fetch', async () => {
  const { cli, previews } = setup();
  await previews.prepare(input);
  expect(cli.exec.mock.calls[0][2]).toMatchObject({ timeout: 600_000 });
});
it('lets a later check replace the config of a preview with no worktree', async () => {
  const { cli, previews } = setup();
  cli.status.mockResolvedValue({ installed: false, loggedIn: false });
  await previews.check(checkInput);
  cli.status.mockResolvedValue({ installed: true, loggedIn: true, user: 'tom' });
  const state = await previews.check({ ...checkInput, config: { ...input.config, coder: { url: 'https://other.example' } } });
  expect(state).toMatchObject({ url: 'https://other.example', cliReady: true, signedIn: true });
});
