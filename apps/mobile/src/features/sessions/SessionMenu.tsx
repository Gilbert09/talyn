import { WORKBENCH_MANUAL_TITLE_MAX, type Workbench } from '@talyn/shared';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Share } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { PromptSheet, useActionSheet, useToast, type SheetAction, type SheetRequest, type Symbol } from '../../components/UI';
import { openExternal } from '../../components/Workflow';
import { trackEvent } from '../../lib/analytics';
import { boxRefusal, showActionError, showBoxRefusal } from '../../lib/errors';
import { useFeatures } from '../../lib/features';
import { threadRoute } from '../../navigation/routes';
import { workbenchKind, workbenchTitle } from '../../workflow/model';
import { spacesOffered } from '../spaces/model';
import { useMoveToSpace, type MoveToSpaceAction } from '../spaces/actions';
import { archiveCopy, copyActions, copyEntry, runningChat, SESSION_ACTION_LABEL, sessionActions, webLink, type SessionActionKind } from './actions';

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
const COPY_ICON: Symbol = { ios: 'doc.on.doc', android: 'content_copy' };
type MoveBuilder = (item: Workbench) => MoveToSpaceAction | null;

/**
 * Loads my teams for "Move to space…". Mounted only while Spaces is offered,
 * so nothing reads teams for an account without it.
 */
function MoveToSpaceBinding({ openSheet, onMoved, onChange }: {
  openSheet(request: SheetRequest): void; onMoved(item: Workbench): void; onChange(build: MoveBuilder | null): void;
}) {
  const build = useMoveToSpace(openSheet, onMoved);
  useEffect(() => { onChange(build); }, [build, onChange]);
  useEffect(() => () => onChange(null), [onChange]);
  return null;
}

/** Session actions listed before the detail screen's PR actions. */
const URGENT = new Set<SessionActionKind>(['stop', 'retry', 'wake']);
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
  const toast = useToast();
  const spaces = spacesOffered(useFeatures());
  const [moveBuilder, setMoveBuilder] = useState<{ build: MoveBuilder } | null>(null);
  const onMoveChange = useCallback((build: MoveBuilder | null) => setMoveBuilder(build ? { build } : null), []);
  const onMoved = useCallback((item: Workbench) => workflow.applyWorkbench(item), [workflow]);
  const copyText = (text: string, done: string) => {
    Clipboard.setStringAsync(text).then(() => toast.show(done), () => Alert.alert('Could not copy', 'Please try again.'));
  };

  const attempt = async (title: string, action: () => Promise<unknown>) => {
    try { await action(); } catch (error) { showActionError(title, error); }
  };
  /** Runs one action. The promise settles when the request does, so a caller can show progress. */
  const perform = (kind: SessionActionKind, item: Workbench, selectedChat: string | null): Promise<void> => {
    const noun = workbenchKind(item) === 'thread' ? 'thread' : 'session';
    switch (kind) {
      case 'stop': {
        const chat = runningChat(item, selectedChat);
        return chat ? attempt('Could not stop the agent', () => workflow.stopChat(item.id, chat.id)) : Promise.resolve();
      }
      case 'wake': return attempt('Could not wake the sandbox', async () => {
        const answer = await workflow.wakeWorkbench(item.id) as { status?: string; code?: unknown; notice?: unknown };
        const refusal = answer?.status === 'exhausted' || answer?.status === 'box_limit'
          ? boxRefusal({ code: answer.code ?? (answer.notice as { code?: unknown } | undefined)?.code, details: { notice: answer.notice } }) : null;
        if (refusal) showBoxRefusal(refusal, 'session_wake');
      });
      case 'retry': return attempt('Could not retry', async () => {
        await workflow.retryWorkbench(item.id);
        trackEvent('session_retry', { workbench_id: item.id });
      });
      case 'rename': setRenaming(item); break;
      case 'open_pr': if (item.pr?.url) openExternal(item.pr.url); break;
      case 'share': void Share.share({ message: webLink(item.id), url: webLink(item.id) }).catch(() => {}); break;
      case 'parent': if (item.threadId) router.push(threadRoute(item.threadId)); break;
      case 'archive': {
        const copy = archiveCopy(item);
        Alert.alert(copy.title, copy.message, [
          { text: 'Cancel', style: 'cancel', isPreferred: true },
          { text: 'Archive', style: 'destructive', onPress: () => void attempt(`Could not archive the ${noun}`, async () => {
            await workflow.archiveWorkbench(item.id);
            trackEvent('session_archived', { workbench_id: item.id, kind: item.kind ?? 'session', runtime: item.runtime });
            onArchived?.(item);
          }) },
        ]);
        break;
      }
      case 'restore': return attempt(`Could not restore the ${noun}`, async () => {
        await workflow.restoreWorkbench(item.id);
        trackEvent('session_restored', { workbench_id: item.id, kind: item.kind ?? 'session', runtime: item.runtime });
      });
    }
    return Promise.resolve();
  };
  /**
   * Opens the menu. The detail screen adds `views` (Changes, Jobs, Details)
   * first and `extra` actions (the PR cycle and the queue) after Stop, Retry
   * and Wake.
   */
  const open = (item: Workbench, more: { views?: SheetAction[]; extra?: SheetAction[] } = {}) => {
    const selectedChat = workflow.local(`selected:${item.id}`).selectedChat;
    const entry = (kind: SessionActionKind): SheetAction => ({
      label: SESSION_ACTION_LABEL[kind], icon: ICONS[kind], destructive: kind === 'archive' || kind === 'stop',
      disabled: offline && NEEDS_NETWORK.has(kind),
      detail: offline && NEEDS_NETWORK.has(kind) ? 'You are offline.' : undefined,
      onPress: () => { void perform(kind, item, selectedChat); },
    });
    const kinds = sessionActions(item, { selectedChat, onThreadScreen });
    const urgent = kinds.filter((kind) => URGENT.has(kind));
    const actions: SheetAction[] = [...(more.views ?? []), ...urgent.map(entry), ...(more.extra ?? []),
      ...kinds.filter((kind) => !URGENT.has(kind)).map(entry)];
    // Archive or Restore stays last, after the copy entries and the move.
    const last = actions.pop();
    for (const kind of copyActions(item)) {
      const copy = copyEntry(kind, item);
      actions.push({ label: copy.label, icon: COPY_ICON, onPress: () => copyText(copy.text, copy.done) });
    }
    const move = moveBuilder?.build(item);
    if (move) actions.push({ label: move.label, icon: move.icon, disabled: move.disabled, detail: move.detail, onPress: move.run });
    if (last) actions.push(last);
    sheet.open({ title: workbenchTitle(item), actions });
  };
  const elements = <>
    {spaces ? <MoveToSpaceBinding openSheet={sheet.open} onMoved={onMoved} onChange={onMoveChange} /> : null}
    {toast.element}
    {sheet.sheet}
    <PromptSheet visible={renaming !== null} title={renaming && workbenchKind(renaming) === 'thread' ? 'Rename thread' : 'Rename session'}
      label="Title" initialValue={renaming ? workbenchTitle(renaming) : ''} maxLength={WORKBENCH_MANUAL_TITLE_MAX}
      onCancel={() => setRenaming(null)}
      onSubmit={(title) => {
        const item = renaming; setRenaming(null);
        if (item) void attempt(`Could not rename the ${workbenchKind(item) === 'thread' ? 'thread' : 'session'}`, () => workflow.renameWorkbench(item.id, title));
      }} />
  </>;
  const run = (kind: SessionActionKind, item: Workbench) => perform(kind, item, workflow.local(`selected:${item.id}`).selectedChat);
  return { open, run, elements, toast: toast.show, openSheet: sheet.open };
}
