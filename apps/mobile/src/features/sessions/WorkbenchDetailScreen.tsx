import type { PRRow } from '@talyn/client/native';
import { fleetAgentLabel, workbenchesOffered, type RepositoryPreviewResponse, type Workbench, type WorkbenchCreation, type WorkbenchReadiness } from '@talyn/shared';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useContext, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { useMobileRuntime, useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { ScreenContainer } from '../../components/ScreenContainer';
import { AppText, Banner, ChipButton, Disclosure, IconButton, Row, SheetModal, useActionSheet, type SheetAction } from '../../components/UI';
import { StateNotice, workflowStyles as styles } from '../../components/Workflow';
import { showActionError } from '../../lib/errors';
import { useFeatures } from '../../lib/features';
import { useKeyboardInset } from '../../lib/keyboard';
import { useNow } from '../../lib/time';
import { completeIntent } from '../../navigation/intents';
import { pullRequestRoute, sessionRoute, threadRoute } from '../../navigation/routes';
import { useResource } from '../../workflow/hooks';
import { alternateChatAgent, workbenchKind } from '../../workflow/model';
import { Conversation } from '../chat/Conversation';
import { isArchived } from './actions';
import { runningJobs } from './background';
import { ChangesTab } from './ChangesTab';
import { CodeCompleteReviewCard } from './CodeCompleteReviewCard';
import { reviewBadge, reviewCard } from './codeComplete';
import { useBackground } from './data';
import { HeaderTitle, QuickActionRow, quickMenuActions, SessionDetailsSheet, SessionStatusRow, useQuickActions } from './DetailHeader';
import { JobsTab } from './JobsTab';
import { readinessProblem, sessionTabs } from './model';
import { PreviewSheet } from './PreviewSheet';
import { PullRequestTab } from './PullRequestTab';
import { diffTotals, primaryActions } from './quickActions';
import { useSessionMenu } from './SessionMenu';
import { WorkbenchRow } from './WorkbenchRow';

type PrDetail = { row: PRRow };
type View_ = 'details' | 'changes' | 'jobs' | 'pr' | 'preview' | null;

const VIEW_ICON = {
  details: { ios: 'info.circle', android: 'info' },
  changes: { ios: 'plus.forwardslash.minus', android: 'difference' },
  jobs: { ios: 'timer', android: 'timer' },
  pr: { ios: 'arrow.triangle.pull', android: 'fork_right' },
  preview: { ios: 'safari', android: 'language' },
} as const;

/** The pull request view, with its own action sheet so "Link" draws above the sheet. */
function PullRequestSheet({ item, visible, onClose, onSent }: { item: Workbench; visible: boolean; onClose(): void; onSent(message: string): void }) {
  const sheet = useActionSheet();
  return <SheetModal visible={visible} onClose={onClose} title="Pull request" full>
    {visible ? <PullRequestTab item={item} openSheet={sheet.open} onSent={onSent} /> : null}
    {sheet.sheet}
  </SheetModal>;
}

export function WorkbenchDetailScreen({ kind, creation, created }: {
  kind: 'session' | 'thread'; creation?: WorkbenchCreation; created?: Workbench;
}) {
  const { workflow } = useMobileRuntime();
  const workspace = useWorkspace();
  const owns = (target: Workbench) => workspace.choices.some(({ id: workspaceId }) => workspaceId === target.workspaceId);
  const params = useLocalSearchParams();
  const id = created?.id ?? (typeof params.id === 'string' ? params.id : '');
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const state = useResource<Workbench>('workbench', id, !creation && Boolean(id), true);
  const fresh = state.status === 'idle' || state.status === 'loading' ? created : undefined;
  const data = state.data ?? (fresh?.workspaceId === workspace.selected ? fresh : undefined);
  const valid = Boolean(data && workbenchKind(data) === kind);
  const features = useFeatures();
  const showChildren = kind === 'thread' || features?.sessionSubagents === true;
  const children = useResource<Workbench[]>('children', id, valid && showChildren);
  const readiness = useResource<WorkbenchReadiness>('readiness', '', valid);
  const offline = useNetwork() === 'offline';
  const now = useNow();
  const item = creation?.workbench ?? (valid ? data : undefined);
  const previewRepo = !creation && kind === 'session' && item?.runtime === 'sandbox' && !isArchived(item) && owns(item)
    && features?.previewLinks === true && workbenchesOffered(features) ? item.repositoryId ?? '' : '';
  const { data: preview } = useResource<RepositoryPreviewResponse>('repositoryPreview', previewRepo, Boolean(previewRepo), true);
  const previewPorts = preview && preview.target !== 'off' && preview.target !== 'coder'
    ? preview.ports.length ? preview.ports : [{ port: 3000 }]
    : null;
  const prId = kind === 'session' ? item?.pullRequestId ?? '' : '';
  const prState = useResource<PrDetail>('pr', prId, Boolean(prId));
  const row = prState.data?.row ?? null;
  const router = useRouter();
  const list = kind === 'session' ? '/sessions' as const : '/threads' as const;
  const menu = useSessionMenu({ onThreadScreen: kind === 'thread',
    onArchived: () => { if (router.canGoBack()) router.back(); else router.replace(list); } });
  useEffect(() => { if (valid) completeIntent(`/${kind === 'session' ? 'sessions' : 'threads'}/${encodeURIComponent(id)}`); }, [valid, kind, id]);
  const childItems = showChildren ? children.data ?? [] : [];
  const keyboard = useKeyboardInset();
  const background = useBackground(creation ? undefined : item);
  const [view, setView] = useState<View_>(null);
  const close = () => setView(null);
  const placeholder = item ?? ({ id, chats: [] } as unknown as Workbench);
  const quick = useQuickActions({ item: placeholder, row, runSession: menu.run, toast: menu.toast });
  const [retrying, setRetrying] = useState(false);
  const [find, setFind] = useState(0);
  const codeFacts = item && kind === 'session' ? { item, row, runningJobs: background.data ? runningJobs(background.data) : null } : null;
  const card = codeFacts ? reviewCard(codeFacts) : null;
  const badge = codeFacts ? reviewBadge(codeFacts) : null;

  let content = null;
  if (item) {
    const actions = creation ? [] : primaryActions(item, row, { offline });
    const problem = readinessProblem(readiness.data, item.agent);
    const notice = !creation && (state.status === 'error' || offline);
    const showParent = features?.sessionSubagents === true && Boolean(item.parentId);
    const fixed = showParent || notice || (Boolean(problem) && !keyboard.open) || (actions.length > 0 && !keyboard.open);
    // Only a real problem and the quick actions stay above the transcript. The rest is in the details sheet.
    const header = fixed ? <View style={local.fixed}>
      {showParent ? <ChipButton label="Open parent session" onPress={() => router.push(item.threadId === item.parentId ? threadRoute(item.parentId!) : sessionRoute(item.parentId!))} /> : null}
      {notice ? <View style={local.notice}><StateNotice resource={state} offline={offline} refresh={state.refresh} /></View> : null}
      {problem && !keyboard.open ? <View style={local.notice}><Banner message={problem} tone="warning" /></View> : null}
      {keyboard.open ? null : <QuickActionRow actions={actions} busy={quick.busy} run={quick.run} />}
    </View> : null;
    content = <Conversation key={item.id} item={item} firstMessage={creation?.message}
      ready={!creation && (Boolean(fresh) || state.status === 'ready' || state.status === 'error')} header={header}
      canSwitchAgent={owns(item)}
      bottom={card && row ? <CodeCompleteReviewCard view={card} row={row} workbenchId={item.id} /> : undefined}
      find={find} onCloseFind={() => setFind(0)}
      top={!creation && showChildren ? (pause) => <View style={{ gap: 4 }}>
        <StateNotice resource={children} offline={offline} refresh={children.refresh} refreshLabel="Refresh child sessions" />
        {childItems.length ? <Disclosure title={`${kind === 'thread' ? 'Related sessions' : 'Sessions started'} (${childItems.length})`} onToggle={pause}>
          <View>{childItems.map((child, index) => <WorkbenchRow key={child.id} item={child} now={now} divider={index < childItems.length - 1} />)}</View>
        </Disclosure> : kind === 'thread' && children.status === 'ready' ? <AppText variant="meta" tone="muted">No sessions started from this thread yet.</AppText> : null}
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
    if (previewPorts) views.push({ label: 'Preview', icon: VIEW_ICON.preview, onPress: () => setView('preview') });
    if (tabs.includes('jobs')) views.push({ label: 'Background jobs', icon: VIEW_ICON.jobs, detail: running ? `${running} running` : undefined,
      onPress: () => setView('jobs') });
    const chat = target.chats?.at(-1);
    const alternate = owns(target) ? alternateChatAgent(target, chat) : undefined;
    const extra = session ? quickMenuActions(target, row, { offline, busy: quick.busy !== null, run: quick.run }) : [];
    if (chat && alternate) extra.unshift({
      label: `Switch to ${fleetAgentLabel(alternate)}`,
      icon: { ios: 'arrow.left.arrow.right', android: 'swap_horiz' },
      detail: chat.status === 'running' ? 'This stops the current turn.' : undefined,
      disabled: offline,
      onPress: () => { void workflow.switchChatAgent(target.id, chat.id, alternate)
        .catch((error) => showActionError('Could not switch agents', error)); },
    });
    menu.open(target, {
      views, prTitle: row?.summary.title, extra,
    });
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
      headerTitle: () => <HeaderTitle item={item} row={row} onPress={creation ? undefined : () => setView('details')} />,
      headerRight: creation ? undefined : () => <View style={local.headerRight}>
        <IconButton label="Find in transcript" symbol={{ ios: 'magnifyingglass', android: 'search' }} onPress={() => setFind((value) => value + 1)} />
        <IconButton label={kind === 'session' ? 'Session actions' : 'Thread actions'}
          symbol={{ ios: 'ellipsis.circle', android: 'more_vert' }} onPress={() => openMenu(item)} />
      </View>,
    }} /> : null}
    <KeyboardAvoidingView style={[styles.page, android && { paddingBottom: keyboard.inset }]}
      behavior={android ? undefined : 'padding'} keyboardVerticalOffset={headerHeight}>
      {item ? <SessionStatusRow item={item} row={row} badge={badge} onChanges={() => setView('changes')} /> : null}
      {item ? content
        : <ScrollView contentContainerStyle={[styles.content, { gap: 12 }]}>
          <StateNotice resource={state} offline={offline} refresh={state.refresh} />
          {state.data && !valid ? <Banner message="This link has the wrong work type. Return to its list." /> : null}
          {state.status === 'deleted' || state.status === 'unauthorized' || (state.data && !valid)
            ? <Row title={kind === 'session' ? 'Back to sessions' : 'Back to threads'} href={kind === 'session' ? '/sessions' : '/threads'} chevron divider={false} />
            : null}
        </ScrollView>}
    </KeyboardAvoidingView>
    {item && !creation ? <>
      <SessionDetailsSheet visible={view === 'details'} onClose={close} item={item} row={row} readiness={readiness.data} onRetry={retry} retrying={retrying} />
      <SheetModal visible={view === 'changes'} onClose={close} title="Changes" full>
        {view === 'changes' ? <ChangesTab item={item} /> : null}
      </SheetModal>
      <SheetModal visible={view === 'jobs'} onClose={close} title="Background jobs" full>
        {view === 'jobs' ? <JobsTab workbenchId={item.id} background={background} /> : null}
      </SheetModal>
      {view === 'preview' && previewPorts ? <PreviewSheet key={item.id} item={item} ports={previewPorts} onClose={close} /> : null}
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
