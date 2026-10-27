import { WORKBENCH_MOVING_MESSAGE } from '@talyn/shared';
import type {
  SendWorkbenchMessageInput,
  Workbench,
  WorkbenchAttachment,
  WorkbenchChanges,
  WorkbenchChat,
  WorkbenchConfig,
  WorkbenchNextAction,
} from '@talyn/shared';
import { api } from './api';
import { toast } from '../stores/toast';
import { useWorkbenchStore } from '../stores/workbenches';

/**
 * One interface over a session's runtime, so no component branches on
 * `runtime`. The desktop app also has a local runtime; the browser has only
 * the sandbox, which calls the backend.
 */
export type WorkbenchPromptActionKind = Exclude<WorkbenchNextAction, 'create_pr' | 'merge' | 'archive' | null>;

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
  config(): Promise<WorkbenchConfig>;
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
  if (workbench.status === 'moving') return WORKBENCH_MOVING_MESSAGE;
  return null;
}

export function sandboxOps(workbench: Workbench): WorkbenchOps {
  const id = workbench.id;
  return {
    runtime: 'sandbox',
    unavailable: sandboxUnavailableReason(workbench),
    canRemoveQueued: true,
    canAttach: true,
    send: (chat, input) => api.workbenches.sendMessage(chat.id, input),
    cancel: (chatId) => api.workbenches.cancel(chatId),
    removeQueued: (chatId, messageId) => {
      api.workbenches
        .removeQueuedMessage(chatId, messageId)
        .then((chat) => useWorkbenchStore.getState().upsertChat(chat))
        .catch((err) => toast.error('Could not remove the queued message', err instanceof Error ? err.message : undefined));
    },
    changes: () => api.workbenches.changes(id),
    diff: async (path) => (await api.workbenches.diff(id, path)).patch,
    listFiles: async () => (await api.workbenches.files(id)).paths,
    readFile: (path) => api.workbenches.file(id, path),
    config: () => api.workbenches.config(id),
    saveDetectedConfig: () => api.workbenches.saveDetectedConfig(id),
    restoreCheckpoint: (chatId, turn) => api.workbenches.restoreCheckpoint(chatId, turn),
    runScript: async (name) => {
      useWorkbenchStore.getState().markScriptStarted(id, name);
      await api.workbenches.runScript(id, name);
    },
    stopScript: (name) => api.workbenches.stopScript(id, name),
    runAction: async (action, chat) => {
      await api.workbenches.action(id, action, chat?.id);
    },
    attach: (file) => api.workbenches.uploadAttachment(
      id,
      new Blob([Uint8Array.from(atob(file.dataBase64), (char) => char.charCodeAt(0))], { type: file.mimeType }),
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
    canRemoveQueued: false,
    canAttach: false,
    send: refuse,
    cancel: refuse,
    removeQueued: () => {},
    changes: refuse,
    diff: refuse,
    listFiles: refuse,
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
