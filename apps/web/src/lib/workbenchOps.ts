import type {
  SendWorkbenchMessageInput,
  Workbench,
  WorkbenchAttachment,
  WorkbenchChanges,
  WorkbenchDiff,
  WorkbenchFileContent,
  WorkbenchFileList,
  WorkbenchDiffScope,
  WorkbenchChat,
  WorkbenchConfig,
  WorkbenchPromptAction,
} from '@talyn/shared';
import { api } from './api';
import { trackEvent } from './analytics';
import { captureWorkbenchFailure } from './workbenchAnalytics';
import { toast } from '../stores/toast';
import { useWorkbenchStore } from '../stores/workbenches';

/**
 * One interface over a session's runtime, so no component branches on
 * `runtime`. The desktop app also has a local runtime; the browser has only
 * the sandbox, which calls the backend.
 */
export type WorkbenchPromptActionKind = Exclude<WorkbenchPromptAction, 'rename_branch'>;

/** A file to attach. An image comes as `dataBase64`; a video comes as its `blob`, which is too large to encode twice. */
export type PastedFile =
  | { name: string; mimeType: string; dataBase64: string; blob?: undefined }
  | { name: string; mimeType: string; blob: Blob; dataBase64?: undefined };

export interface WorkbenchOps {
  readonly runtime: Workbench['runtime'];
  /** Null when this client can act on the workbench; otherwise why not. */
  readonly unavailable: string | null;
  /**
   * Null when the Changes and Files tabs can read; otherwise why not. An
   * archived sandbox session still reads the copy Talyn stored.
   */
  readonly readUnavailable: string | null;
  /** Whether a queued message can be taken back. */
  readonly canRemoveQueued: boolean;
  /** Whether pasted images and videos can be attached. */
  readonly canAttach: boolean;
  send(chat: WorkbenchChat, input: SendWorkbenchMessageInput): Promise<{ queued: boolean }>;
  cancel(chatId: string): Promise<void>;
  removeQueued(chatId: string, messageId: string): void;
  /** A sleeping sandbox answers with its stored list (`snapshotAt` set); `live` wakes it and reads it. */
  changes(opts?: { live?: boolean }): Promise<WorkbenchChanges>;
  /**
   * Unified diff for one file, or the whole branch. A sleeping sandbox answers
   * from the stored copy or GitHub (`source`), or refuses with
   * `snapshot_unavailable` (see {@link needsWake}); `live` wakes it.
   */
  diff(path?: string, scope?: WorkbenchDiffScope, opts?: { live?: boolean }): Promise<WorkbenchDiff>;
  listFiles(): Promise<string[]>;
  /** The file list, with where it came from. `live` wakes a sleeping sandbox. */
  files(opts?: { live?: boolean }): Promise<WorkbenchFileList>;
  readFile(path: string, opts?: { live?: boolean }): Promise<WorkbenchFileContent>;
  config(opts?: { live?: boolean }): Promise<WorkbenchConfig>;
  saveDetectedConfig(): Promise<void>;
  restoreCheckpoint(chatId: string, turn: number): Promise<void>;
  runScript(name: string): Promise<void>;
  stopScript(name: string): Promise<void>;
  /** Fix checks / Resolve conflicts — a prompt to the agent. */
  runAction(action: WorkbenchPromptActionKind, chat: WorkbenchChat | null): Promise<void>;
  attach(file: PastedFile): Promise<WorkbenchAttachment>;
  attachmentBlob(path: string, mimeType: string): Promise<Blob>;
}

// ============================================================================
// Sandbox
// ============================================================================

/** Why a sandbox workbench cannot be acted on right now, or null. */
export function sandboxUnavailableReason(workbench: Workbench): string | null {
  if (workbench.status === 'archived' || workbench.archivedAt) return 'This session is archived.';
  if (workbench.status === 'error' || workbench.sandboxState === 'error') {
    return workbench.error || workbench.statusMessage || 'The sandbox failed to start.';
  }
  if (workbench.sandboxState === 'lost') return 'The sandbox was lost. Talyn is starting a new one.';
  if (workbench.status === 'provisioning') return 'The sandbox is starting.';
  return null;
}

/**
 * True when a read was refused because the sandbox sleeps and Talyn stored no
 * copy of what was asked for. Only a read with `live` wakes the box for it.
 */
export function needsWake(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 'snapshot_unavailable';
}

export function sandboxOps(workbench: Workbench): WorkbenchOps {
  const id = workbench.id;
  const unavailable = sandboxUnavailableReason(workbench);
  return {
    runtime: 'sandbox',
    unavailable,
    // An archived session has no box, but its stored copy still reads.
    readUnavailable: workbench.status === 'archived' || workbench.archivedAt ? null : unavailable,
    canRemoveQueued: true,
    canAttach: true,
    send: (chat, input) => api.workbenches.sendMessage(chat.id, input),
    cancel: (chatId) => api.workbenches.cancel(chatId),
    removeQueued: (chatId, messageId) => {
      api.workbenches
        .removeQueuedMessage(chatId, messageId)
        .then((chat) => useWorkbenchStore.getState().upsertChat(chat))
        .catch((err) => {
          captureWorkbenchFailure('remove_queued_message', err, id);
          toast.error('Could not remove the queued message', err instanceof Error ? err.message : undefined);
        });
    },
    changes: (opts) => api.workbenches.changes(id, opts),
    diff: (path, scope, opts) => api.workbenches.diff(id, path, scope, opts),
    listFiles: async () => (await api.workbenches.files(id)).paths,
    files: (opts) => api.workbenches.files(id, opts),
    readFile: (path, opts) => api.workbenches.file(id, path, opts),
    config: (opts) => api.workbenches.config(id, opts),
    saveDetectedConfig: () => api.workbenches.saveDetectedConfig(id),
    restoreCheckpoint: (chatId, turn) => api.workbenches.restoreCheckpoint(chatId, turn),
    runScript: async (name) => {
      useWorkbenchStore.getState().markScriptStarted(id, name);
      await api.workbenches.runScript(id, name);
      if (name === 'setup' || name === 'run' || name === 'archive') trackEvent('session_script_run', { workbench_id: id, script_kind: name });
    },
    stopScript: (name) => api.workbenches.stopScript(id, name),
    runAction: async (action, chat) => {
      await api.workbenches.action(id, action, chat?.id);
    },
    attach: (file) => api.workbenches.uploadAttachment(
      id,
      // `slice` relabels the bytes without copying them: a `.mov` file can arrive with no type.
      file.blob ? file.blob.slice(0, file.blob.size, file.mimeType) : new Blob([Uint8Array.from(atob(file.dataBase64), (char) => char.charCodeAt(0))], { type: file.mimeType }),
      file.name
    ),
    attachmentBlob: (path) => api.workbenches.attachmentBlob(id, path),
  };
}

/**
 * The browser has no local runtime, so every session gets the sandbox ops. A
 * local session made in the desktop app says so instead of failing each call.
 */
export function opsFor(workbench: Workbench): WorkbenchOps {
  if (workbench.runtime === 'local') return localUnavailableOps(workbench);
  return sandboxOps(workbench);
}

const LOCAL_UNAVAILABLE = 'This session runs on a computer with the Talyn desktop app. Open it there.';

function localUnavailableOps(workbench: Workbench): WorkbenchOps {
  const refuse = (): Promise<never> => Promise.reject(new Error(LOCAL_UNAVAILABLE));
  return {
    runtime: workbench.runtime,
    unavailable: LOCAL_UNAVAILABLE,
    readUnavailable: LOCAL_UNAVAILABLE,
    canRemoveQueued: false,
    canAttach: false,
    send: refuse,
    cancel: refuse,
    removeQueued: () => {},
    changes: refuse,
    diff: refuse,
    listFiles: refuse,
    files: refuse,
    readFile: refuse,
    config: refuse,
    saveDetectedConfig: refuse,
    restoreCheckpoint: refuse,
    runScript: refuse,
    stopScript: refuse,
    runAction: refuse,
    attach: refuse,
    attachmentBlob: refuse,
  };
}
