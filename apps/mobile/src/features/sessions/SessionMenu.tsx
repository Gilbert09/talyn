import { WORKBENCH_MANUAL_TITLE_MAX, type Workbench } from '@talyn/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Share } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { PromptSheet, useActionSheet, type SheetAction, type Symbol } from '../../components/UI';
import { openExternal } from '../../components/Workflow';
import { boxRefusal, showActionError, showBoxRefusal } from '../../lib/errors';
import { threadRoute } from '../../navigation/routes';
import { workbenchKind, workbenchTitle } from '../../workflow/model';
import { archiveCopy, runningChat, SESSION_ACTION_LABEL, sessionActions, webLink, type SessionActionKind } from './actions';

const ICONS: Record<SessionActionKind, Symbol> = {
  stop: { ios: 'stop.circle', android: 'stop_circle' },
  wake: { ios: 'sun.max', android: 'wb_sunny' },
  retry: { ios: 'arrow.clockwise', android: 'refresh' },
  rename: { ios: 'pencil', android: 'edit' },
  open_pr: { ios: 'arrow.up.right.square', android: 'open_in_new' },
  share: { ios: 'square.and.arrow.up', android: 'share' },
  parent: { ios: 'bubble.left.and.bubble.right', android: 'chat' },
  archive: { ios: 'archivebox', android: 'archive' },
  restore: { ios: 'arrow.uturn.backward', android: 'unarchive' },
};
/** Actions that need the server. Offline they show but cannot be chosen. */
const NEEDS_NETWORK = new Set<SessionActionKind>(['stop', 'wake', 'retry', 'rename', 'archive', 'restore']);

/**
 * The session and thread action menu, shared by the detail header and a long
 * press on a list row. Render `elements` last inside the screen.
 */
export function useSessionMenu({ onArchived, onThreadScreen = false }: { onArchived?(item: Workbench): void; onThreadScreen?: boolean } = {}) {
  const { workflow } = useMobileRuntime();
  const router = useRouter();
  const offline = useNetwork() === 'offline';
  const sheet = useActionSheet();
  const [renaming, setRenaming] = useState<Workbench | null>(null);

  const attempt = async (title: string, action: () => Promise<unknown>) => {
    try { await action(); } catch (error) { showActionError(title, error); }
  };
  const perform = (kind: SessionActionKind, item: Workbench, selectedChat: string | null) => {
    const noun = workbenchKind(item) === 'thread' ? 'thread' : 'session';
    switch (kind) {
      case 'stop': {
        const chat = runningChat(item, selectedChat);
        if (chat) void attempt('Could not stop the agent', () => workflow.stopChat(item.id, chat.id));
        return;
      }
      case 'wake': void attempt('Could not wake the sandbox', async () => {
        const answer = await workflow.wakeWorkbench(item.id) as { status?: string; code?: unknown; notice?: unknown };
        const refusal = answer?.status === 'exhausted' || answer?.status === 'box_limit'
          ? boxRefusal({ code: answer.code ?? (answer.notice as { code?: unknown } | undefined)?.code, details: { notice: answer.notice } }) : null;
        if (refusal) showBoxRefusal(refusal);
      }); return;
      case 'retry': void attempt('Could not retry', () => workflow.retryWorkbench(item.id)); return;
      case 'rename': setRenaming(item); return;
      case 'open_pr': if (item.pr?.url) openExternal(item.pr.url); return;
      case 'share': void Share.share({ message: webLink(item.id), url: webLink(item.id) }).catch(() => {}); return;
      case 'parent': if (item.threadId) router.push(threadRoute(item.threadId)); return;
      case 'archive': {
        const copy = archiveCopy(item);
        Alert.alert(copy.title, copy.message, [
          { text: 'Cancel', style: 'cancel', isPreferred: true },
          { text: 'Archive', style: 'destructive', onPress: () => void attempt(`Could not archive the ${noun}`, async () => {
            await workflow.archiveWorkbench(item.id);
            onArchived?.(item);
          }) },
        ]);
        return;
      }
      case 'restore': void attempt(`Could not restore the ${noun}`, () => workflow.restoreWorkbench(item.id));
    }
  };
  const open = (item: Workbench) => {
    const selectedChat = workflow.local(`selected:${item.id}`).selectedChat;
    const actions: SheetAction[] = sessionActions(item, { selectedChat, onThreadScreen }).map((kind) => ({
      label: SESSION_ACTION_LABEL[kind], icon: ICONS[kind], destructive: kind === 'archive' || kind === 'stop',
      disabled: offline && NEEDS_NETWORK.has(kind),
      detail: offline && NEEDS_NETWORK.has(kind) ? 'You are offline.' : undefined,
      onPress: () => perform(kind, item, selectedChat),
    }));
    sheet.open({ title: workbenchTitle(item), actions });
  };
  const elements = <>
    {sheet.sheet}
    <PromptSheet visible={renaming !== null} title={renaming && workbenchKind(renaming) === 'thread' ? 'Rename thread' : 'Rename session'}
      label="Title" initialValue={renaming ? workbenchTitle(renaming) : ''} maxLength={WORKBENCH_MANUAL_TITLE_MAX}
      onCancel={() => setRenaming(null)}
      onSubmit={(title) => {
        const item = renaming; setRenaming(null);
        if (item) void attempt(`Could not rename the ${workbenchKind(item) === 'thread' ? 'thread' : 'session'}`, () => workflow.renameWorkbench(item.id, title));
      }} />
  </>;
  return { open, elements };
}
