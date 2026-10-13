import {
  applyWorkbenchScriptOverrides,
  checkpointRestoreSteps,
  diffNameStatus,
  diffNumstat,
  diffPatch,
  headSha,
  listCheckpointRefs,
  listFiles,
  mergeBase,
  mergeChangedFiles,
  parseCheckpointRefs,
  parseNulList,
  resolveWorkbenchActionPrompt,
  resolveWorkbenchConfig,
  untrackedFilePatch,
  untrackedFiles,
  workbenchEnv,
  type GitStep,
  type SendWorkbenchMessageInput,
  type Workbench,
  type WorkbenchAttachment,
  type WorkbenchChanges,
  type WorkbenchChat,
  type WorkbenchLocalBridge,
  type WorkbenchNextAction,
} from '@talyn/shared';
import { api } from './api';
import { getDeviceId, getWorkbenchBridge } from './workbenchBridge';
import { getLocalController, type LocalTurnController } from './localWorkbench';
import { useWorkbenchStore } from '../stores/workbenches';

/**
 * One interface over both runtimes, so no component branches on `runtime`.
 * The sandbox implementation calls the backend; the local one drives the
 * Electron bridge with the shared git steps and parsers.
 */
export type WorkbenchPromptActionKind = Exclude<WorkbenchNextAction, 'merge' | 'archive' | null>;

export interface PastedFile {
  name: string;
  mimeType: string;
  dataBase64: string;
}

export interface WorkbenchOps {
  readonly runtime: Workbench['runtime'];
  /** Null when this client can act on the workbench; otherwise why not. */
  readonly unavailable: string | null;
  /** Whether a queued message can be taken back. */
  readonly canRemoveQueued: boolean;
  /** Whether pasted images can be attached. */
  readonly canAttach: boolean;
  send(chat: WorkbenchChat, input: SendWorkbenchMessageInput): Promise<{ queued: boolean }>;
  cancel(chatId: string): Promise<void>;
  removeQueued(chatId: string, messageId: string): void;
  changes(): Promise<WorkbenchChanges>;
  /** Unified diff text for one file, or the whole branch. */
  diff(path?: string): Promise<string>;
  listFiles(): Promise<string[]>;
  readFile(path: string): Promise<{ content: string; binary: boolean }>;
  restoreCheckpoint(chatId: string, turn: number): Promise<void>;
  runScript(name: string): Promise<void>;
  stopScript(name: string): Promise<void>;
  /** Create PR / Fix checks / Resolve conflicts — a prompt to the agent. */
  runAction(action: WorkbenchPromptActionKind, chat: WorkbenchChat | null): Promise<void>;
  attach(file: PastedFile): Promise<WorkbenchAttachment>;
}

// ============================================================================
// Sandbox
// ============================================================================

export function sandboxOps(workbench: Workbench): WorkbenchOps {
  const id = workbench.id;
  return {
    runtime: 'sandbox',
    unavailable: null,
    canRemoveQueued: false,
    canAttach: false,
    send: (chat, input) => api.workbenches.sendMessage(chat.id, input),
    cancel: (chatId) => api.workbenches.cancel(chatId),
    removeQueued: () => {
      throw new Error('A sandbox queue cannot be edited yet.');
    },
    changes: () => api.workbenches.changes(id),
    diff: async (path) => (await api.workbenches.diff(id, path)).patch,
    listFiles: async () => (await api.workbenches.files(id)).paths,
    readFile: (path) => api.workbenches.file(id, path),
    restoreCheckpoint: (chatId, turn) => api.workbenches.restoreCheckpoint(chatId, turn),
    runScript: async (name) => {
      useWorkbenchStore.getState().markScriptStarted(id, name);
      await api.workbenches.runScript(id, name);
    },
    stopScript: (name) => api.workbenches.stopScript(id, name),
    runAction: async (action, chat) => {
      await api.workbenches.action(id, action, chat?.id);
    },
    attach: async () => {
      throw new Error('Attachments are not supported in sandbox workbenches yet.');
    },
  };
}

// ============================================================================
// Local
// ============================================================================

const ATTACHMENT_DIR = '.context/attachments';

function stepOf(argv: string[]): GitStep {
  return { argv };
}

export function localOps(
  workbench: Workbench,
  bridge: WorkbenchLocalBridge | null = getWorkbenchBridge(),
  controller: LocalTurnController | null = getLocalController()
): WorkbenchOps {
  const path = workbench.localPath ?? '';
  const unavailable = !bridge
    ? 'This local workbench needs the Talyn desktop app.'
    : workbench.deviceId && workbench.deviceId !== getDeviceId()
      ? 'This workbench lives on another computer. Open it there.'
      : !path
        ? 'This workbench has no local path.'
        : null;

  const need = (): WorkbenchLocalBridge => {
    if (!bridge || unavailable) throw new Error(unavailable ?? 'Local runtime unavailable.');
    return bridge;
  };
  const run = async (steps: GitStep[]): Promise<string> => {
    const res = await need().exec(path, steps);
    if (res.exitCode !== 0 && !steps.every((s) => s.allowFailure)) {
      throw new Error(res.stderr.trim() || `git exited with ${res.exitCode}`);
    }
    return res.stdout;
  };

  /** The merge-base with the remote base when there is one, else the local branch. */
  const base = async (): Promise<string> => {
    for (const ref of [`origin/${workbench.baseBranch}`, workbench.baseBranch]) {
      const res = await need().exec(path, [mergeBase(ref)]);
      if (res.exitCode === 0 && res.stdout.trim()) return res.stdout.trim();
    }
    throw new Error(`Could not find the merge-base with ${workbench.baseBranch}.`);
  };

  const scriptCommand = async (name: string): Promise<string | null> => {
    const read = async (rel: string) => {
      try {
        const file = await need().readFile(path, rel);
        return file.binary ? null : file.content;
      } catch {
        return null;
      }
    };
    const [talynToml, conductorJson, conductorToml] = await Promise.all([
      read('.talyn/settings.toml'),
      read('conductor.json'),
      read('.conductor/settings.toml'),
    ]);
    const config = applyWorkbenchScriptOverrides(
      resolveWorkbenchConfig({ talynToml, conductorJson, conductorToml }),
      workbench.settings
    );
    if (name === 'setup') return config.setup?.command ?? null;
    if (name === 'archive') return config.archive?.command ?? null;
    if (name === 'run') return config.run.find((s) => s.default)?.command ?? null;
    return config.run.find((s) => s.name === name)?.command ?? null;
  };

  const ops: WorkbenchOps = {
    runtime: 'local',
    unavailable,
    canRemoveQueued: true,
    canAttach: !unavailable,
    send: async (chat, input) => {
      need();
      if (!controller) throw new Error('Local runtime unavailable.');
      return controller.send(workbench, chat, input);
    },
    cancel: async (chatId) => {
      if (!controller) throw new Error('Local runtime unavailable.');
      await controller.cancel(chatId);
    },
    removeQueued: (chatId, messageId) => useWorkbenchStore.getState().removeLocalQueued(chatId, messageId),
    changes: async () => {
      const sha = await base();
      const [numstat, nameStatus, untracked, head] = await Promise.all([
        run([diffNumstat(sha)]),
        run([diffNameStatus(sha)]),
        run([untrackedFiles()]),
        run([headSha()]),
      ]);
      return { files: mergeChangedFiles({ numstat, nameStatus, untracked }), base: sha, headSha: head.trim() };
    },
    diff: async (file) => {
      const sha = await base();
      const patch = await run([diffPatch(sha, file)]);
      if (patch.trim() || !file) return patch;
      // An untracked file has no diff against a commit; show it as an addition.
      return run([untrackedFilePatch(file)]);
    },
    listFiles: async () => parseNulList(await run([listFiles()])),
    readFile: (rel) => need().readFile(path, rel),
    restoreCheckpoint: async (chatId, turn) => {
      const refs = parseCheckpointRefs(await run([listCheckpointRefs(chatId)]));
      const hit = refs.find((r) => r.turn === turn);
      if (!hit) throw new Error(`No checkpoint was taken before turn ${turn}.`);
      const gitDir = (await run([stepOf(['git', 'rev-parse', '--absolute-git-dir'])])).trim();
      await run(checkpointRestoreSteps({ sha: hit.sha, tmpIndexPath: `${gitDir}/talyn-restore-index` }));
    },
    runScript: async (name) => {
      const command = await scriptCommand(name);
      if (!command) throw new Error(`No ${name} script is configured for this repository.`);
      useWorkbenchStore.getState().markScriptStarted(workbench.id, name);
      await need().scripts.run({
        workbenchId: workbench.id,
        path,
        name,
        command,
        env: workbenchEnv({ workbenchPath: path, rootPath: path, name: workbench.name, port: portFor(workbench.id), defaultBranch: workbench.baseBranch }),
      });
    },
    stopScript: (name) => need().scripts.stop({ workbenchId: workbench.id, name }),
    runAction: async (action, chat) => {
      if (!chat) throw new Error('Open a chat first.');
      const prompt = resolveWorkbenchActionPrompt(action, workbench.settings, {
        branch: workbench.branch,
        baseBranch: workbench.baseBranch,
      });
      await ops.send(chat, { text: prompt });
    },
    attach: async (file) => {
      const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+/, '') || 'attachment';
      const rel = `${ATTACHMENT_DIR}/${Date.now()}-${safe}`;
      await run([
        stepOf([
          'sh',
          '-c',
          'mkdir -p "$(dirname "$2")" && printf %s "$1" | base64 -d > "$2"',
          'sh',
          file.dataBase64,
          rel,
        ]),
      ]);
      return { name: file.name, mimeType: file.mimeType, path: rel };
    },
  };
  return ops;
}

/**
 * The first of ten ports this workbench's scripts may use. Stable per
 * workbench, so a dev server comes back on the same port after a restart.
 */
export function portFor(workbenchId: string): number {
  let hash = 0;
  for (let i = 0; i < workbenchId.length; i++) hash = (hash * 31 + workbenchId.charCodeAt(i)) >>> 0;
  return 40000 + (hash % 2000) * 10;
}

export function opsFor(workbench: Workbench): WorkbenchOps {
  return workbench.runtime === 'local' ? localOps(workbench) : sandboxOps(workbench);
}
