import { workbenchesOffered, type EffectivePreview, type Workbench, type WorkbenchEvent } from '@talyn/shared';
import type { CoderPreviewState, CoderStep } from '../../workbenchBridgeTypes';
import { api } from './api';
import { getWorkbenchBridge } from './workbenchBridge';
import { useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore } from '../stores/workspace';
import { toast } from '../stores/toast';

const operations = new Map<string, Promise<unknown>>();
const turns = new Map<string, number>();
const errors = new Map<string, string>();
const progress = new Map<string, { step: CoderStep; detail: string }>();

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
  const current = progress.get(id);
  return { busy: operations.has(id), step: current?.step ?? null, detail: current?.detail ?? null, error: errors.get(id) ?? null };
}

function setProgress(id: string, step: CoderStep | null, detail = ''): void {
  if (step) progress.set(id, { step, detail });
  else progress.delete(id);
  coderPreviewChanged();
}

/** Runs one action at a time per session, and keeps its error for the panel. */
export function coderAction<T>(id: string, action: () => Promise<T>): Promise<T> {
  const next = (operations.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => {
    errors.delete(id);
    coderPreviewChanged();
    return action();
  });
  operations.set(id, next);
  coderPreviewChanged();
  void next.catch((error) => { errors.set(id, errorText(error)); }).finally(() => {
    if (operations.get(id) === next) operations.delete(id);
    progress.delete(id);
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
