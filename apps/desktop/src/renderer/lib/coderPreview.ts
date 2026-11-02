import { workbenchesOffered, type EffectivePreview, type Workbench, type WorkbenchEvent } from '@talyn/shared';
import type { CoderPreviewState, CoderStep } from '../../workbenchBridgeTypes';
import { api } from './api';
import { getWorkbenchBridge } from './workbenchBridge';
import { useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore } from '../stores/workspace';
import { toast } from '../stores/toast';
import { useCoderPreviewStatusStore } from '../stores/coderPreviewStatus';

const operations = new Map<string, Promise<unknown>>();
const turns = new Map<string, number>();
const updateStatus = useCoderPreviewStatusStore.getState().update;

export async function refreshCoderPreview(id: string): Promise<CoderPreviewState | null> {
  const state = await coderPreviewBridge().state(id);
  updateStatus(id, { state, refreshError: null });
  return state;
}

export function coderPreviewBridge() {
  const bridge = getWorkbenchBridge()?.coderPreview;
  if (!bridge) throw new Error('Restart Talyn to enable Coder previews.');
  return bridge;
}

export function coderPreviewChanged(): void {
  window.dispatchEvent(new Event('coder-preview-changed'));
}

/** Electron adds "Error invoking remote method '…': Error: " to every error from the main process. */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, '');
}

/** What the renderer knows about a session's preview: an action runs, its step, and its last error. */
export function coderProgress(id: string): { busy: boolean; step: CoderStep | null; detail: string | null; error: string | null } {
  const { busy, step, detail, error } = useCoderPreviewStatusStore.getState().sessions[id]
    ?? { busy: false, step: null, detail: null, error: null };
  return { busy, step, detail, error };
}

function setProgress(id: string, step: CoderStep | null, detail = ''): void {
  updateStatus(id, { step, detail: step ? detail : null });
  coderPreviewChanged();
}

/** Runs one action at a time per session, and keeps its error for the panel. */
export function coderAction<T>(id: string, action: () => Promise<T>): Promise<T> {
  const next = (operations.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => {
    updateStatus(id, { error: null });
    coderPreviewChanged();
    return action();
  });
  operations.set(id, next);
  updateStatus(id, { busy: true, error: null });
  coderPreviewChanged();
  const poll = window.setInterval(() => { void refreshCoderPreview(id).catch(() => undefined); }, 1000);
  void refreshCoderPreview(id).catch(() => undefined);
  void next.catch((error) => { updateStatus(id, { error: errorText(error) }); }).finally(() => {
    window.clearInterval(poll);
    void refreshCoderPreview(id).catch(() => undefined);
    if (operations.get(id) === next) {
      operations.delete(id);
      updateStatus(id, { busy: false, step: null, detail: null });
    }
    coderPreviewChanged();
  });
  return next;
}

export async function syncCoderPreview(id: string, turn?: number) {
  setProgress(id, 'sync', "Reading the session's changes from the sandbox. A sandbox that slept can take a few minutes to wake.");
  const patch = await api.workbenches.patch(id);
  setProgress(id, null);
  return coderPreviewBridge().sync({ sessionId: id, ...patch, turn });
}

const checkInput = (workbench: Workbench, config: EffectivePreview) =>
  ({ sessionId: workbench.id, repoName: workbench.repoFullName, config });

/** The read-only checks. A failed check is in the returned state's `problem`. */
export function checkCoderPreview(workbench: Workbench, config: EffectivePreview): Promise<CoderPreviewState> {
  return coderAction(workbench.id, () => coderPreviewBridge().check(checkInput(workbench, config)));
}

export function startCoderWorkspace(id: string): Promise<CoderPreviewState> {
  return coderAction(id, () => coderPreviewBridge().startWorkspace(id));
}

/**
 * Checks first, so a missing CLI or a stopped workspace answers in seconds.
 * Reading the patch can wake a sleeping sandbox, which takes longer.
 */
export function startCoderPreview(workbench: Workbench, config: EffectivePreview) {
  return coderAction(workbench.id, async () => {
    const bridge = coderPreviewBridge();
    const checked = await bridge.check(checkInput(workbench, config));
    if (checked?.problem && checked.problem.action !== 'start_workspace') throw new Error(checked.error || checked.problem.message);
    coderPreviewChanged();
    setProgress(workbench.id, 'sync', "Reading the session's changes from the sandbox. A sandbox that slept can take a few minutes to wake.");
    const patch = await api.workbenches.patch(workbench.id);
    setProgress(workbench.id, null);
    await bridge.prepare({ sessionId: workbench.id, repoName: workbench.repoFullName, base: patch.base, config });
    coderPreviewChanged();
    await bridge.sync({ sessionId: workbench.id, ...patch });
    coderPreviewChanged();
    await bridge.run(workbench.id);
    coderPreviewChanged();
    await bridge.open(workbench.id);
  });
}

export function syncCoderTurn(chatId: string, events: WorkbenchEvent[]): void {
  if (!workbenchesOffered(useWorkspaceStore.getState().features)) return;
  const bridge = getWorkbenchBridge()?.coderPreview;
  if (!bridge) return;
  const ended = events.filter((item) => item.event.type === 'result');
  if (!ended.length) return;
  const turn = Math.max(...ended.map((item) => item.turn));
  if (turn <= (turns.get(chatId) ?? -1)) return;
  const store = useWorkbenchStore.getState();
  const chat = Object.values(store.chats).flat().find((item) => item.id === chatId);
  if (!chat) return;
  turns.set(chatId, turn);
  void coderAction(chat.workbenchId, async () => {
    const state = await bridge.state(chat.workbenchId);
    if (state?.active) await syncCoderPreview(chat.workbenchId, turn);
  }).catch((error) => {
    turns.delete(chatId);
    toast.error('Could not sync the Coder preview', errorText(error));
  });
}

export function stopCoderPreview(id: string): void {
  const bridge = getWorkbenchBridge()?.coderPreview;
  if (!bridge) return;
  void coderAction(id, () => bridge.stop(id)).catch((error) => {
    toast.error('Could not stop the Coder preview', errorText(error));
  });
}
