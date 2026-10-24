import { workbenchesOffered, type EffectivePreview, type Workbench, type WorkbenchEvent } from '@talyn/shared';
import { api } from './api';
import { getWorkbenchBridge } from './workbenchBridge';
import { useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore } from '../stores/workspace';
import { toast } from '../stores/toast';

const operations = new Map<string, Promise<unknown>>();
const turns = new Map<string, number>();

export function coderPreviewBridge() {
  const bridge = getWorkbenchBridge()?.coderPreview;
  if (!bridge) throw new Error('Restart Talyn to enable Coder previews.');
  return bridge;
}

export function coderPreviewChanged(): void {
  window.dispatchEvent(new Event('coder-preview-changed'));
}

export function coderAction<T>(id: string, action: () => Promise<T>): Promise<T> {
  const next = (operations.get(id) ?? Promise.resolve()).catch(() => undefined).then(action);
  operations.set(id, next);
  void next.finally(() => {
    if (operations.get(id) === next) operations.delete(id);
    coderPreviewChanged();
  }).catch(() => undefined);
  return next;
}

export async function syncCoderPreview(id: string, turn?: number) {
  const patch = await api.workbenches.patch(id);
  return coderPreviewBridge().sync({ sessionId: id, ...patch, turn });
}

export function startCoderPreview(workbench: Workbench, config: EffectivePreview) {
  return coderAction(workbench.id, async () => {
    const bridge = coderPreviewBridge();
    const patch = await api.workbenches.patch(workbench.id);
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
    toast.error('Could not sync the Coder preview', error instanceof Error ? error.message : undefined);
  });
}

export function stopCoderPreview(id: string): void {
  const bridge = getWorkbenchBridge()?.coderPreview;
  if (!bridge) return;
  void coderAction(id, () => bridge.stop(id)).catch((error) => {
    toast.error('Could not stop the Coder preview', error instanceof Error ? error.message : undefined);
  });
}
