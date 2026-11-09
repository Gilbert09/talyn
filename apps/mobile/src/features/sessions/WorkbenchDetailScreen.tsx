import type { PRRow } from '@talyn/client/native';
import type { Workbench, WorkbenchReadiness } from '@talyn/shared';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useContext, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { ScreenContainer } from '../../components/ScreenContainer';
import { AppText, Banner, Disclosure, IconButton, Row, SheetModal, useActionSheet, type SheetAction } from '../../components/UI';
import { StateNotice, workflowStyles as styles } from '../../components/Workflow';
import { useKeyboardInset } from '../../lib/keyboard';
import { useNow } from '../../lib/time';
import { completeIntent } from '../../navigation/intents';
import { pullRequestRoute } from '../../navigation/routes';
import { useResource } from '../../workflow/hooks';
import { workbenchKind } from '../../workflow/model';
import { Conversation } from '../chat/Conversation';
import { runningJobs } from './background';
import { ChangesTab } from './ChangesTab';
import { useBackground } from './data';
import { HeaderTitle, HeaderTrailing, QuickActionRow, quickMenuActions, SessionDetailsSheet, useQuickActions } from './DetailHeader';
import { JobsTab } from './JobsTab';
import { readinessProblem, sessionTabs } from './model';
import { PullRequestTab } from './PullRequestTab';
import { diffTotals, primaryActions } from './quickActions';
import { useSessionMenu } from './SessionMenu';
import { WorkbenchRow } from './WorkbenchRow';

type PrDetail = { row: PRRow };
type View_ = 'details' | 'changes' | 'jobs' | 'pr' | null;

const VIEW_ICON = {
  details: { ios: 'info.circle', android: 'info' },
  changes: { ios: 'plus.forwardslash.minus', android: 'difference' },
  jobs: { ios: 'timer', android: 'timer' },
  pr: { ios: 'arrow.triangle.pull', android: 'fork_right' },
} as const;

/** The pull request view, with its own action sheet so "Link" draws above the sheet. */
function PullRequestSheet({ item, visible, onClose, onSent }: { item: Workbench; visible: boolean; onClose(): void; onSent(message: string): void }) {
  const sheet = useActionSheet();
  return <SheetModal visible={visible} onClose={onClose} title="Pull request" full>
    {visible ? <PullRequestTab item={item} openSheet={sheet.open} onSent={onSent} /> : null}
    {sheet.sheet}
  </SheetModal>;
}

export function WorkbenchDetailScreen({ kind }: { kind: 'session' | 'thread' }) {
  const params = useLocalSearchParams();
  const id = typeof params.id === 'string' ? params.id : '';
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const { workflow } = useMobileRuntime();
  const state = useResource<Workbench>('workbench', id, Boolean(id), true);
  const valid = Boolean(state.data && workbenchKind(state.data) === kind);
  const children = useResource<Workbench[]>('children', id, valid && kind === 'thread');
  const readiness = useResource<WorkbenchReadiness>('readiness', '', valid);
  const offline = useNetwork() === 'offline';
  const now = useNow();
  const item = valid ? state.data : undefined;
  const prId = kind === 'session' ? item?.pullRequestId ?? '' : '';
  const prState = useResource<PrDetail>('pr', prId, Boolean(prId));
  const row = prState.data?.row ?? null;
  const router = useRouter();
  const list = kind === 'session' ? '/sessions' as const : '/threads' as const;
  const menu = useSessionMenu({ onThreadScreen: kind === 'thread',
    onArchived: () => { if (router.canGoBack()) router.back(); else router.replace(list); } });
  useEffect(() => { if (item) completeIntent(`/${kind === 'session' ? 'sessions' : 'threads'}/${encodeURIComponent(id)}`); }, [item, kind, id]);
  const childItems = kind === 'thread' ? children.data ?? [] : [];
  const keyboard = useKeyboardInset();
  const background = useBackground(item);
  const [view, setView] = useState<View_>(null);
  const close = () => setView(null);
  const placeholder = item ?? ({ id, chats: [] } as unknown as Workbench);
  const quick = useQuickActions({ item: placeholder, row, runSession: menu.run, toast: menu.toast });
  const [retrying, setRetrying] = useState(false);

  let content = null;
  if (item) {
    const selectedChat = workflow.local(`selected:${item.id}`).selectedChat;
    const actions = primaryActions(item, row, { selectedChat, offline });
    const problem = readinessProblem(readiness.data, item.agent);
    const notice = state.status === 'error' || offline;
    const fixed = notice || (Boolean(problem) && !keyboard.open) || (actions.length > 0 && !keyboard.open);
    // Only a real problem and the quick actions stay above the transcript. The rest is in the details sheet.
    const header = fixed ? <View style={local.fixed}>
      {notice ? <View style={local.notice}><StateNotice resource={state} offline={offline} refresh={state.refresh} /></View> : null}
      {problem && !keyboard.open ? <View style={local.notice}><Banner message={problem} tone="warning" /></View> : null}
      {keyboard.open ? null : <QuickActionRow actions={actions} busy={quick.busy} run={quick.run} />}
    </View> : null;
    content = <Conversation key={item.id} item={item} ready={state.status === 'ready' || state.status === 'error'} header={header}
      top={kind === 'thread' ? (pause) => <View style={{ gap: 4 }}>
        <StateNotice resource={children} offline={offline} refresh={children.refresh} refreshLabel="Refresh child sessions" />
        {childItems.length ? <Disclosure title={`Related sessions (${childItems.length})`} onToggle={pause}>
          <View>{childItems.map((child, index) => <WorkbenchRow key={child.id} item={child} now={now} divider={index < childItems.length - 1} />)}</View>
        </Disclosure> : children.status === 'ready' ? <AppText variant="meta" tone="muted">No sessions started from this thread yet.</AppText> : null}
      </View> : undefined} />;
  }

  const openMenu = (target: Workbench) => {
    const session = kind === 'session';
    const jobs = background.data?.jobs.length ?? 0;
    const running = runningJobs(background.data);
    const tabs = session ? sessionTabs(target, { jobs }) : [];
    const totals = diffTotals(target);
    const views: SheetAction[] = [{ label: 'Details', icon: VIEW_ICON.details, onPress: () => setView('details') }];
    if (tabs.includes('changes')) views.push({ label: 'Changes', icon: VIEW_ICON.changes,
      detail: totals ? `${totals.files} ${totals.files === 1 ? 'file' : 'files'}, +${totals.added} −${totals.removed}` : undefined, onPress: () => setView('changes') });
    if (tabs.includes('pr')) views.push({ label: 'Pull request', icon: VIEW_ICON.pr, detail: target.pullRequestId ? undefined : 'None yet. Create or link one.',
      onPress: () => { if (target.pullRequestId) router.push(pullRequestRoute(target.pullRequestId)); else setView('pr'); } });
    if (tabs.includes('jobs')) views.push({ label: 'Background jobs', icon: VIEW_ICON.jobs, detail: running ? `${running} running` : undefined,
      onPress: () => setView('jobs') });
    menu.open(target, { views, extra: session ? quickMenuActions(target, row, { offline, busy: quick.busy !== null, run: quick.run }) : [] });
  };
  const retry = () => {
    if (!item) return;
    setRetrying(true);
    void menu.run('retry', item).finally(() => setRetrying(false));
  };

  // iOS resizes through the avoiding view. An edge-to-edge Android window does not resize, so it gets the keyboard's height as padding. Android passes no behavior: a disabled padding view writes paddingBottom 0 over this style.
  const android = Platform.OS === 'android';
  return <ScreenContainer>
    {item ? <Stack.Screen options={{
      headerTitle: () => <HeaderTitle item={item} row={row} onPress={() => setView('details')} />,
      headerRight: () => <View style={local.headerRight}>
        <HeaderTrailing item={item} row={row} onChanges={() => setView('changes')} />
        <IconButton label={kind === 'session' ? 'Session actions' : 'Thread actions'}
          symbol={{ ios: 'ellipsis.circle', android: 'more_vert' }} onPress={() => openMenu(item)} />
      </View>,
    }} /> : null}
    <KeyboardAvoidingView style={[styles.page, android && { paddingBottom: keyboard.inset }]}
      behavior={android ? undefined : 'padding'} keyboardVerticalOffset={headerHeight}>
      {item ? content
        : <ScrollView contentContainerStyle={[styles.content, { gap: 12 }]}>
          <StateNotice resource={state} offline={offline} refresh={state.refresh} />
          {state.data && !valid ? <Banner message="This link has the wrong work type. Return to its list." /> : null}
          {state.status === 'deleted' || state.status === 'unauthorized' || (state.data && !valid)
            ? <Row title={kind === 'session' ? 'Back to sessions' : 'Back to threads'} href={kind === 'session' ? '/sessions' : '/threads'} chevron divider={false} />
            : null}
        </ScrollView>}
    </KeyboardAvoidingView>
    {item ? <>
      <SessionDetailsSheet visible={view === 'details'} onClose={close} item={item} row={row} readiness={readiness.data} onRetry={retry} retrying={retrying} />
      <SheetModal visible={view === 'changes'} onClose={close} title="Changes" full>
        {view === 'changes' ? <ChangesTab item={item} /> : null}
      </SheetModal>
      <SheetModal visible={view === 'jobs'} onClose={close} title="Background jobs" full>
        {view === 'jobs' ? <JobsTab workbenchId={item.id} background={background} /> : null}
      </SheetModal>
      <PullRequestSheet item={item} visible={view === 'pr'} onClose={close} onSent={(message) => { close(); menu.toast(message); }} />
    </> : null}
    {menu.elements}
  </ScreenContainer>;
}

const local = StyleSheet.create({
  fixed: { paddingTop: 4, paddingBottom: 2 },
  notice: { paddingHorizontal: 16, paddingBottom: 4 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 2 },
});
