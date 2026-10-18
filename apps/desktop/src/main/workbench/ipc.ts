import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import { promises as fs } from 'fs';
import type { GitStep, WorkbenchLocalBridge } from '@talyn/shared';
import { AgentProcesses } from './agentProcess';
import { detectAgents, localReadiness, loginPath } from './environment';
import {
  exec,
  git,
  listFiles,
  readFile,
  stopGitProcesses,
  WorktreeManager,
} from './git';
import { WorkbenchPaths } from './paths';
import { PrDrafts } from './prDraft';
import { RepoPaths, repoFullNameFromRemote } from './repoPaths';
import { Scripts } from './scripts';
import { Terminals } from './terminals';

export async function pickRepoFolder(repoPaths?: RepoPaths): Promise<{
  path: string;
  remoteUrl: string | null;
} | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Select a Git repository',
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const root = await git(result.filePaths[0], 'rev-parse', '--show-toplevel');
  let remoteUrl: string | null = null;
  try {
    remoteUrl = await git(root, 'remote', 'get-url', 'origin');
  } catch {
    /* A local repository can have no remote. */
  }
  const repoFullName = remoteUrl ? repoFullNameFromRemote(remoteUrl) : null;
  if (repoPaths && repoFullName)
    await repoPaths.set({ repoFullName, path: root }).catch(() => undefined);
  return { path: root, remoteUrl };
}

export function registerWorkbenchIpc(
  getWindow: () => BrowserWindow | null,
): void {
  const paths = new WorkbenchPaths(app.getPath('userData'));
  const repoPaths = new RepoPaths(app.getPath('userData'));
  const emit = (channel: string, payload: unknown) => {
    const window = getWindow();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send(channel, payload);
  };
  const trees = new WorktreeManager(paths);
  const agents = new AgentProcesses(paths, emit);
  const prDrafts = new PrDrafts();
  const terminals = new Terminals(emit);
  const scripts = new Scripts(paths, terminals, emit);
  let shuttingDown = false;
  let stopped = false;
  void loginPath();

  const handle = <Args extends unknown[], Result>(
    channel: string,
    callback: (...args: Args) => Result,
  ) => {
    ipcMain.handle(`workbench:${channel}`, (event, ...args) => {
      if (shuttingDown) throw new Error('The runtime is shutting down');
      const window = getWindow();
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error('Invalid workbench sender');
      return callback(...(args as Args));
    });
  };
  handle(
    'create-worktree',
    (input: Parameters<WorkbenchLocalBridge['createWorktree']>[0]) =>
      trees.createWorktree(input),
  );
  handle(
    'remove-worktree',
    async (input: Parameters<WorkbenchLocalBridge['removeWorktree']>[0]) => {
      const state = await paths.load(input.path);
      if (state) {
        await agents.stopWorkbench(state.workbenchId);
        await scripts.stopWorkbench(state.workbenchId);
        await terminals.stopWorkbench(state.workbenchId);
      }
      await trees.removeWorktree(input);
    },
  );
  handle(
    'start-turn',
    (input: Parameters<WorkbenchLocalBridge['startTurn']>[0]) =>
      agents.startTurn(input),
  );
  handle('cancel-turn', (chatId: string) => agents.cancelTurn(chatId));
  handle(
    'pr-draft',
    (input: Parameters<WorkbenchLocalBridge['draftPullRequest']>[0]) =>
      prDrafts.draft(input),
  );
  handle('exec', async (worktree: string, steps: GitStep[]) => {
    // Give checkpoint steps a private index outside the worktree.
    const replacements = new Map<string, string>();
    try {
      for (const step of steps) {
        const index = step.env?.GIT_INDEX_FILE;
        if (index && !replacements.has(index))
          replacements.set(index, await paths.tempIndex());
      }
      return await exec(
        worktree,
        steps.map((step) => ({
          ...step,
          argv: step.argv.map((arg) => replacements.get(arg) ?? arg),
          ...(step.env
            ? {
                env: Object.fromEntries(
                  Object.entries(step.env).map(([key, value]) => [
                    key,
                    replacements.get(value) ?? value,
                  ]),
                ),
              }
            : {}),
        })),
      );
    } finally {
      await Promise.all(
        [...replacements.values()].map((index) =>
          fs.rm(index, { force: true }),
        ),
      );
    }
  });
  handle('read-file', readFile);
  handle('list-files', listFiles);
  handle(
    'terminal:open',
    (input: Parameters<WorkbenchLocalBridge['terminal']['open']>[0]) =>
      terminals.open({
        ...input,
        kind: input.kind === 'shell' ? 'terminal' : 'agent',
      }),
  );
  handle('terminal:write', (id: string, data: string) =>
    terminals.write(id, data),
  );
  handle('terminal:resize', (id: string, cols: number, rows: number) =>
    terminals.resize(id, cols, rows),
  );
  handle('terminal:close', (id: string) => terminals.close(id));
  handle(
    'scripts:run',
    (input: Parameters<WorkbenchLocalBridge['scripts']['run']>[0]) =>
      scripts.run(input),
  );
  handle(
    'scripts:stop',
    (input: Parameters<WorkbenchLocalBridge['scripts']['stop']>[0]) =>
      scripts.stop(input),
  );
  handle('detect-agents', detectAgents);
  handle(
    'pick-repo-folder',
    async () => (await pickRepoFolder(repoPaths))?.path ?? null,
  );
  handle('readiness', (force?: boolean) => localReadiness(force === true));
  handle('repo-paths:get', () => repoPaths.get());
  handle(
    'repo-paths:set',
    (input: { repoFullName: string; path: string }) => repoPaths.set(input),
  );
  handle('repo-paths:remove', (repoFullName: string) =>
    repoPaths.remove(repoFullName),
  );

  app.on('before-quit', (event) => {
    if (stopped) return;
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    stopGitProcesses();
    prDrafts.shutdown();
    void Promise.allSettled([
      agents.shutdown(),
      scripts.shutdown(),
      terminals.shutdown(),
    ]).then(() => {
      stopped = true;
      app.quit();
    });
  });
}
