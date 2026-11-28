import type { PRRow } from '@talyn/client/native';
import { canCloseSessionPullRequest, sessionAutomation, type Workbench, type WorkbenchReadiness } from '@talyn/shared';
import { useRouter } from 'expo-router';
import { useContext, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { PrPill, PrStatusPill, SessionStateIcon } from '../../components/Status';
import { AppText, Banner, ChipButton, Dot, Row, SheetModal, toneColor, type SheetAction, type Symbol, type Tone } from '../../components/UI';
import { NativeText } from '../../components/Workflow';
import { trackEvent } from '../../lib/analytics';
import { showActionError } from '../../lib/errors';
import { chatDetailsLine } from '../../lib/models';
import { prRowStatus, workbenchState } from '../../lib/status';
import { longTime, relativeTimeLabel, useNow } from '../../lib/time';
import { pullRequestRoute, threadRoute } from '../../navigation/routes';
import { useTheme } from '../../theme/tokens';
import { workbenchKind, workbenchTitle } from '../../workflow/model';
import { queueStateLabel } from '../prs/actions';
import { CodeReviewSummary } from '../prs/CodeReviewSection';
import { canRetry, isArchived, type SessionActionKind } from './actions';
import { readinessProblem } from './model';
import { canQueue, cycleActions, cycleDisabledReason, cycleLabel, diffTotals, type QuickAction, type QuickActionKind } from './quickActions';
import { runPromptAction, sendCreatePullRequest } from './sessionPrActions';

export const QUICK_ACTION_ICON: Record<QuickActionKind | 'queue_add' | 'queue_remove', Symbol> = {
  create_pr: { ios: 'arrow.triangle.pull', android: 'fork_right' },
  resolve_conflicts: { ios: 'arrow.triangle.branch', android: 'call_split' },
  fix_checks: { ios: 'wrench.and.screwdriver', android: 'build' },
  merge: { ios: 'arrow.triangle.merge', android: 'merge' },
  archive: { ios: 'archivebox', android: 'archive' },
  retry: { ios: 'arrow.clockwise', android: 'refresh' },
  restore: { ios: 'arrow.uturn.backward', android: 'unarchive' },
  queue_add: { ios: 'text.badge.plus', android: 'playlist_add' },
  queue_remove: { ios: 'text.badge.minus', android: 'playlist_remove' },
};

const CLOSE_PR_ICON: Symbol = { ios: 'xmark.circle', android: 'cancel' };

type RunnableKind = QuickActionKind | 'queue_add' | 'queue_remove' | 'close_pr';

/** Web's header offers "Close pull request" for an open PR the person or this session opened. */
export const canClosePr = (item: Workbench, row: PRRow | null): row is PRRow =>
  Boolean(row) && !isArchived(item) && workbenchKind(item) === 'session' && canCloseSessionPullRequest(item, row);

/**
 * Runs the same client calls and confirmations as web `WorkbenchHeader`.
 * The header and the menu share the same handlers.
 */
export function useQuickActions({ item, row, runSession, toast }: {
  item: Workbench; row: PRRow | null;
  runSession(kind: SessionActionKind, item: Workbench): Promise<void>;
  toast(message: string): void;
}) {
  const { workflow } = useMobileRuntime();
  const [busy, setBusy] = useState<RunnableKind | null>(null);
  const track = async (kind: RunnableKind, action: () => Promise<void>) => {
    setBusy(kind);
    try { await action(); } finally { setBusy(null); }
  };
  const attempt = (kind: RunnableKind, title: string, action: () => Promise<string | void>) => track(kind, async () => {
    try {
      const done = await action();
      if (done) toast(done);
    } catch (error) { showActionError(title, error); }
  });
  const ref = row ? `#${row.number}` : '';
  const merge = () => {
    if (!row) return;
    const summary = row.summary;
    // Web confirms a merge. The words match the PR screen's confirmation.
    Alert.alert(`Merge ${ref}?`, `Squash-merge "${summary.title}" into ${summary.baseBranch || 'its base branch'} on GitHub.`, [
      { text: 'Cancel', style: 'cancel', isPreferred: true },
      { text: 'Merge', onPress: () => void attempt('merge', `Could not merge ${ref}`, async () => {
        const result = await workflow.mergePr(row.id);
        if (result.submitted) return `Submitted ${ref} to the merge queue.`;
        if (result.alreadyTerminal) return `${ref} was already ${result.merged ? 'merged' : 'closed'}.`;
        if (!result.merged) throw new Error(result.message || 'GitHub did not merge the pull request.');
        return `Merged ${ref}.`;
      }) },
    ]);
  };
  const closePr = () => {
    if (!row) return;
    // Web confirms a close too. The words match its dialog.
    Alert.alert(`Close ${ref}?`, `"${row.summary.title}" closes on GitHub without merging. The branch and this session stay. You can reopen the pull request on GitHub.`, [
      { text: 'Cancel', style: 'cancel', isPreferred: true },
      { text: 'Close pull request', style: 'destructive', onPress: () => void attempt('close_pr', `Could not close ${ref}`, async () => {
        const result = await workflow.closePr(row.id);
        trackEvent('pull_request_closed', { workbench_id: item.id, already_closed: result.alreadyClosed });
        return result.alreadyClosed ? `${ref} was already closed.` : `Closed ${ref}.`;
      }) },
    ]);
  };
  const run = (kind: RunnableKind) => {
    if (busy) return;
    switch (kind) {
      case 'retry': case 'restore': void track(kind, () => runSession(kind, item)); return;
      case 'archive': void runSession('archive', item); return;
      case 'create_pr': void attempt(kind, 'Could not create the pull request', () => sendCreatePullRequest(workflow, item)); return;
      case 'resolve_conflicts': case 'fix_checks':
        void attempt(kind, `Could not ${cycleLabel(kind, row, item).toLowerCase()}`, () => runPromptAction(workflow, item, kind)); return;
      case 'merge': merge(); return;
      case 'close_pr': closePr(); return;
      case 'queue_add': case 'queue_remove': {
        if (!row) return;
        const enabled = kind === 'queue_add';
        void attempt(kind, `Could not ${enabled ? 'queue' : 'dequeue'} ${ref}`, async () => {
          await workflow.setMergeQueue(row.id, enabled);
          return enabled ? `Added ${ref} to the merge queue.` : `Removed ${ref} from the merge queue.`;
        });
        return;
      }
    }
  };
  return { busy, run };
}

/** The menu entries for the PR cycle and the queue, after Stop, Retry and Wake in the session menu. Mirrors web's header dropdown. */
export function quickMenuActions(item: Workbench, row: PRRow | null, options: { offline: boolean; busy: boolean; run(kind: RunnableKind): void }): SheetAction[] {
  const out: SheetAction[] = [];
  const reasonFor = (reason: string | null) => options.offline ? 'You are offline.' : reason ?? undefined;
  for (const action of cycleActions(item, row)) {
    const reason = reasonFor(cycleDisabledReason(action, item, row));
    out.push({ label: cycleLabel(action, row, item), icon: QUICK_ACTION_ICON[action], detail: reason,
      disabled: options.busy || Boolean(reason), onPress: () => options.run(action) });
  }
  if (canQueue(item, row)) {
    const kind = row.mergeQueued ? 'queue_remove' : 'queue_add';
    const reason = reasonFor(null);
    out.push({ label: row.mergeQueued ? 'Remove from merge queue' : 'Add to merge queue', icon: QUICK_ACTION_ICON[kind],
      detail: reason ?? (row.mergeQueued ? queueStateLabel(row) : undefined),
      disabled: options.busy || Boolean(reason), onPress: () => options.run(kind) });
  }
  if (canClosePr(item, row)) {
    const reason = reasonFor(null);
    out.push({ label: 'Close pull request', icon: CLOSE_PR_ICON, destructive: true, detail: reason,
      disabled: options.busy || Boolean(reason), onPress: () => options.run('close_pr') });
  }
  return out;
}

type ActionProps = { action: QuickAction; busy: RunnableKind | null; run(kind: QuickActionKind): void };

export function ThreadQuickAction({ action, busy, run }: ActionProps) {
  return <View accessibilityRole="toolbar" accessibilityLabel="Quick actions" style={styles.threadAction}>
    <ChipButton label={action.label} icon={QUICK_ACTION_ICON[action.kind]} variant="primary"
      loading={busy === action.kind} disabled={Boolean(action.disabledReason) || (busy !== null && busy !== action.kind)}
      hint={action.disabledReason ?? action.hint} onPress={() => run(action.kind)} />
  </View>;
}

function actionContext(item: Workbench, row: PRRow | null, kind: QuickActionKind): {
  title: string; reason: string; tone: Tone; view: 'changes' | 'details' | 'pr';
} {
  if (kind === 'retry') return { title: 'Sandbox', reason: 'Failed to start', tone: 'destructive', view: 'details' };
  if (kind === 'create_pr') {
    const files = diffTotals(item)?.files;
    const reason = files ? `${files} ${files === 1 ? 'file' : 'files'} changed` : 'Branch has changes';
    return { title: 'Changes', reason, tone: 'muted', view: 'changes' };
  }
  const number = row?.number ?? item.pr?.number;
  const title = number ? `PR #${number}` : 'Pull request';
  const view = item.pullRequestId ? 'pr' : 'details';
  if (kind === 'fix_checks') {
    const checks = row?.summary.checks;
    const reason = checks?.failed ? `${checks.failed} of ${checks.total} checks failing` : 'Checks failing';
    return { title, reason, tone: 'destructive', view };
  }
  if (kind === 'resolve_conflicts') return { title, reason: 'Merge conflicts', tone: 'warning', view };
  if (kind === 'merge') return { title, reason: 'Ready to merge', tone: 'success', view };
  const merged = (row?.state ?? item.pr?.state) === 'merged';
  return { title, reason: merged ? 'Merged' : 'Closed', tone: merged ? 'merged' : 'muted', view };
}

export function SessionNextAction({ item, row, action, busy, run, onDetails, onChanges }: ActionProps & {
  item: Workbench; row: PRRow | null; onDetails(): void; onChanges(): void;
}) {
  const c = useTheme();
  const router = useRouter();
  const { title, reason, tone, view } = actionContext(item, row, action.kind);
  const openContext = () => {
    if (view === 'changes') onChanges();
    else if (view === 'pr' && item.pullRequestId) router.push(pullRequestRoute(item.pullRequestId));
    else onDetails();
  };
  return <View accessibilityRole="toolbar" accessibilityLabel="Next action"
    style={[styles.nextAction, { backgroundColor: c.elevated, borderColor: c.border }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${title}. ${reason}.`}
      onPress={openContext} style={({ pressed }) => [styles.actionContext, { opacity: pressed ? 0.6 : 1 }]}>
      <AppText variant="rowTitle" numberOfLines={1}>{title}</AppText>
      <View style={styles.actionReason}>
        <Dot size={6} color={toneColor(c, tone)} />
        <AppText variant="caption" tone={tone} numberOfLines={2} style={styles.actionReasonText}>{reason}</AppText>
      </View>
    </Pressable>
    <ChipButton label={action.label} variant="primary" style={styles.nextActionButton} loading={busy === action.kind}
      disabled={Boolean(action.disabledReason) || (busy !== null && busy !== action.kind)}
      hint={action.disabledReason ?? action.hint} onPress={() => run(action.kind)} />
  </View>;
}

/** The native title opens session details. Threads still show the state icon. */
export function HeaderTitle({ item, row, showRepository = false, onPress }: {
  item: Workbench; row: PRRow | null; showRepository?: boolean; onPress?(): void;
}) {
  const { width } = useWindowDimensions();
  const insets = useContext(SafeAreaInsetsContext);
  const state = workbenchState(item, row);
  const title = workbenchTitle(item);
  const kind = workbenchKind(item);
  const session = kind === 'session';
  const status = session && isArchived(item) ? 'Archived' : state.label;
  // Sessions reserve one 40 dp button. Threads also reserve the search button and gap.
  const right = session ? 40 + 16 : 2 * 40 + 2 + 16;
  const available = width - (insets?.left ?? 0) - (insets?.right ?? 0);
  const maxWidth = Math.max(0, Platform.OS === 'ios' ? available - 2 * right : available - right - 88);
  return <Pressable accessibilityRole="header" accessibilityLabel={`${title}. ${status}.`}
    accessibilityHint={onPress ? `Shows the ${kind} details.` : undefined} onPress={onPress} hitSlop={6}
    style={({ pressed }) => [session ? styles.sessionTitle : styles.threadTitle,
      { maxWidth, width: session ? maxWidth : undefined, opacity: pressed ? 0.6 : 1 }]}>
    {session ? <>
      <AppText variant="rowTitle" numberOfLines={1}>{title}</AppText>
      <AppText variant="caption" tone="muted" numberOfLines={1}>
        {showRepository && item.repoFullName ? item.repoFullName : status}
      </AppText>
    </> : <>
      <SessionStateIcon state={state} />
      <AppText variant="rowTitle" numberOfLines={1} style={{ flexShrink: 1 }}>{title}</AppText>
    </>}
  </Pressable>;
}

/**
 * Shows the full session title, metadata, and related work.
 */
export function SessionDetailsSheet({ visible, onClose, item, row, readiness, onRetry, retrying }: {
  visible: boolean; onClose(): void; item: Workbench; row: PRRow | null; readiness?: WorkbenchReadiness;
  onRetry(): void; retrying: boolean;
}) {
  const { workflow } = useMobileRuntime();
  const offline = useNetwork() === 'offline';
  const router = useRouter();
  const now = useNow();
  const kind = workbenchKind(item);
  const state = workbenchState(item, row);
  const selected = workflow.local(`selected:${item.id}`).selectedChat;
  const chat = (item.chats ?? []).find((value) => value.id === selected) ?? item.chats?.at(-1);
  const agent = chatDetailsLine(chat, item.agent);
  const problem = readinessProblem(readiness, item.agent);
  const updated = relativeTimeLabel(item.updatedAt, now);
  const go = (href: Parameters<typeof router.push>[0]) => { onClose(); router.push(href); };
  const facts: Array<[string, string]> = [
    ['Repository', item.repoFullName],
    ['Branch', kind === 'session' && item.branch ? `${item.branch} → ${item.baseBranch || 'main'}` : ''],
    ['Updated', updated ? `${updated} · ${longTime(item.updatedAt)}` : ''],
    ['Agent', agent],
  ];
  const number = row?.number ?? item.pr?.number;
  const automation = sessionAutomation(item.source);
  return <SheetModal visible={visible} onClose={onClose} title={kind === 'thread' ? 'Thread details' : 'Session details'}>
    <ScrollView contentContainerStyle={styles.details}>
      <AppText selectable accessibilityRole="header" variant="rowTitle" style={{ fontSize: 17, lineHeight: 23 }}>{workbenchTitle(item)}</AppText>
      <View style={styles.state}>
        <SessionStateIcon state={state} />
        <AppText variant="meta" tone="muted" style={{ flex: 1 }}>{state.label}</AppText>
      </View>
      {canRetry(item) ? <Banner tone="destructive" message={item.error ?? item.statusMessage ?? 'The session hit an error. Retry, or archive it.'}
        action={retrying ? 'Retrying' : 'Retry'} onAction={onRetry} actionDisabled={retrying || offline} />
        : item.statusMessage ? <NativeText text={item.statusMessage} /> : null}
      {problem ? <Banner message={problem} tone="warning" /> : null}
      <View>
        {facts.filter(([, value]) => value).map(([label, value]) => <View key={label} style={styles.fact} accessible accessibilityLabel={`${label}: ${value}`}>
          <AppText variant="meta" tone="muted" style={styles.factLabel}>{label}</AppText>
          <AppText selectable variant="meta" style={{ flex: 1 }}>{value}</AppText>
        </View>)}
      </View>
      {item.pullRequestId && number ? <Row divider={false} chevron onPress={() => go(pullRequestRoute(item.pullRequestId!))}
        title={row?.summary.title ?? `Pull request #${number}`} titleLines={2}
        accessibilityLabel={`Pull request ${number}${row ? `: ${row.summary.title}. ${prRowStatus(row).label}` : ''}. Open the pull request.`}
        trailing={<PrPill number={number} state={row?.state ?? item.pr?.state ?? 'open'} draft={row?.summary.draft} />}>
        {row ? <View style={{ alignSelf: 'flex-start' }}><PrStatusPill variant={prRowStatus(row)} /></View> : null}
      </Row> : null}
      {row?.codeReview ? <CodeReviewSummary review={row.codeReview} pullRequestId={row.id} sessionId={item.id}
        onPress={() => go(pullRequestRoute(row.id, { tab: 'findings' }))} /> : null}
      {item.threadId ? <Row divider={false} chevron title="Open parent thread" onPress={() => go(threadRoute(item.threadId!))} /> : null}
      {automation ? <Row divider={false} chevron title={`${automation.label} automation`} subtitle="Started this session"
        accessibilityLabel={`Open the ${automation.label} automation that started this session`}
        onPress={() => go({ pathname: '/integrations/[kind]/[id]', params: { kind: automation.kind, id: automation.id } })} /> : null}
    </ScrollView>
  </SheetModal>;
}

const styles = StyleSheet.create({
  threadAction: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 6 },
  sessionTitle: { justifyContent: 'center' },
  threadTitle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nextAction: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end',
    columnGap: 12, rowGap: 4, paddingHorizontal: 16, paddingVertical: 2, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  actionContext: { flexBasis: 120, flexGrow: 1, minWidth: 48, minHeight: 48, justifyContent: 'center' },
  nextActionButton: { minWidth: 48, minHeight: 48, justifyContent: 'center' },
  actionReason: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  actionReasonText: { flexShrink: 1 },
  details: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 24, gap: 12 },
  state: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fact: { flexDirection: 'row', gap: 12, paddingVertical: 4 },
  factLabel: { width: 88 },
});
