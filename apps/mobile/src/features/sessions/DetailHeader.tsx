import type { PRRow } from '@talyn/client/native';
import type { Workbench, WorkbenchReadiness } from '@talyn/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { PrPill, PrStatusPill, SessionStateIcon } from '../../components/Status';
import { AppText, Banner, ChipButton, PrNumber, Row, SheetModal, type SheetAction, type Symbol, type Tone } from '../../components/UI';
import { NativeText } from '../../components/Workflow';
import { showActionError } from '../../lib/errors';
import { chatDetailsLine } from '../../lib/models';
import { prNumberTone, prRowStatus, workbenchState } from '../../lib/status';
import { longTime, relativeTimeLabel, useNow } from '../../lib/time';
import { pullRequestRoute, threadRoute } from '../../navigation/routes';
import { mono, useTheme } from '../../theme/tokens';
import { workbenchKind, workbenchTitle } from '../../workflow/model';
import { canRetry, type SessionActionKind } from './actions';
import { readinessProblem } from './model';
import { canQueue, cycleActions, cycleDisabledReason, cycleLabel, diffTotals, type QuickAction, type QuickActionKind } from './quickActions';
import { runPromptAction, sendCreatePullRequest } from './sessionPrActions';

export const QUICK_ACTION_ICON: Record<QuickActionKind | 'queue_remove', Symbol> = {
  create_pr: { ios: 'arrow.triangle.pull', android: 'fork_right' },
  resolve_conflicts: { ios: 'arrow.triangle.branch', android: 'call_split' },
  fix_checks: { ios: 'wrench.and.screwdriver', android: 'build' },
  merge: { ios: 'arrow.triangle.merge', android: 'merge' },
  archive: { ios: 'archivebox', android: 'archive' },
  stop: { ios: 'stop.circle', android: 'stop_circle' },
  retry: { ios: 'arrow.clockwise', android: 'refresh' },
  wake: { ios: 'sun.max', android: 'wb_sunny' },
  restore: { ios: 'arrow.uturn.backward', android: 'unarchive' },
  queue_add: { ios: 'text.badge.plus', android: 'playlist_add' },
  queue_remove: { ios: 'text.badge.minus', android: 'playlist_remove' },
  queue_status: { ios: 'list.number', android: 'format_list_numbered' },
};

type RunnableKind = QuickActionKind | 'queue_remove';

/**
 * Runs the header's quick actions with the same client calls and confirmations
 * as web `WorkbenchHeader`. Session actions go through the session menu, so a
 * chip and a menu entry behave the same.
 */
export function useQuickActions({ item, row, runSession, toast }: {
  item: Workbench; row: PRRow | null;
  runSession(kind: SessionActionKind, item: Workbench): Promise<void>;
  toast(message: string): void;
}) {
  const { workflow } = useMobileRuntime();
  const router = useRouter();
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
  const run = (kind: RunnableKind) => {
    if (busy) return;
    switch (kind) {
      case 'stop': case 'retry': case 'wake': case 'restore': void track(kind, () => runSession(kind, item)); return;
      case 'archive': void runSession('archive', item); return;
      case 'create_pr': void attempt(kind, 'Could not create the pull request', () => sendCreatePullRequest(workflow, item)); return;
      case 'resolve_conflicts': case 'fix_checks':
        void attempt(kind, `Could not ${cycleLabel(kind, row, item).toLowerCase()}`, () => runPromptAction(workflow, item, kind)); return;
      case 'merge': merge(); return;
      case 'queue_add': case 'queue_remove': {
        if (!row) return;
        const enabled = kind === 'queue_add';
        void attempt(kind, `Could not ${enabled ? 'queue' : 'dequeue'} ${ref}`, async () => {
          await workflow.setMergeQueue(row.id, enabled);
          return enabled ? `Added ${ref} to the merge queue.` : `Removed ${ref} from the merge queue.`;
        });
        return;
      }
      case 'queue_status': if (row) router.push(pullRequestRoute(row.id));
    }
  };
  return { busy, run };
}

/** The menu entries for the PR cycle and the queue, after Stop, Retry and Wake. Mirrors web's header dropdown. */
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
    out.push({ label: row.mergeQueued ? 'Remove from merge queue' : 'Add to merge queue', icon: QUICK_ACTION_ICON[kind], detail: reason,
      disabled: options.busy || Boolean(reason), onPress: () => options.run(kind) });
  }
  return out;
}

/** The one slim row of quick actions. Nothing renders without an action. */
export function QuickActionRow({ actions, busy, run }: { actions: QuickAction[]; busy: RunnableKind | null; run(kind: QuickActionKind): void }) {
  if (!actions.length) return null;
  return <View accessibilityRole="toolbar" accessibilityLabel="Quick actions" style={styles.actions}>
    {actions.map((action, index) => <ChipButton key={action.kind} label={action.label} icon={QUICK_ACTION_ICON[action.kind]}
      variant={index === 0 && action.kind !== 'archive' && action.kind !== 'queue_status' ? 'primary' : 'secondary'}
      loading={busy === action.kind} disabled={Boolean(action.disabledReason) || (busy !== null && busy !== action.kind)}
      hint={action.disabledReason ?? action.hint} onPress={() => run(action.kind)} />)}
  </View>;
}

/** Width the header's trailing items take, so the title knows how much it may use. */
function trailingWidth(item: Workbench) {
  const session = workbenchKind(item) === 'session';
  return 44 + (session && item.pullRequestId ? 56 : 0) + (session && diffTotals(item) ? 84 : 0);
}

/** The native header's title: state icon and one line of title. Tapping it opens the details. */
export function HeaderTitle({ item, row, onPress }: { item: Workbench; row: PRRow | null; onPress(): void }) {
  const { width } = useWindowDimensions();
  const state = workbenchState(item, row);
  const title = workbenchTitle(item);
  const right = trailingWidth(item);
  // iOS centres the title, so it gets the same room on both sides. Android puts it after the back button.
  const maxWidth = Math.max(120, Platform.OS === 'ios' ? width - 2 * Math.max(right, 72) : width - right - 88);
  return <Pressable accessibilityRole="header" accessibilityLabel={`${title}. ${state.label}.`}
    accessibilityHint={`Shows the ${workbenchKind(item)} details.`} onPress={onPress} hitSlop={6}
    style={({ pressed }) => [styles.title, { maxWidth, opacity: pressed ? 0.6 : 1 }]}>
    <SessionStateIcon state={state} />
    <AppText variant="rowTitle" numberOfLines={1} style={{ flexShrink: 1 }}>{title}</AppText>
  </Pressable>;
}

/** The header's trailing marks: the branch's +/- count (opens Changes) and the PR number (opens the PR). */
export function HeaderTrailing({ item, row, onChanges }: { item: Workbench; row: PRRow | null; onChanges(): void }) {
  const c = useTheme();
  const router = useRouter();
  if (workbenchKind(item) !== 'session') return null;
  const totals = diffTotals(item);
  const number = row?.number ?? item.pr?.number;
  const status = row ? prRowStatus(row) : null;
  const tone = (row?.state === 'open' && status ? status.tone : prNumberTone(row?.state ?? item.pr?.state ?? 'open', row?.summary.draft)) as Tone;
  return <>
    {totals ? <Pressable accessibilityRole="button" accessibilityLabel={`Changes: ${totals.files} ${totals.files === 1 ? 'file' : 'files'}, ${totals.added} added, ${totals.removed} removed`}
      onPress={onChanges} hitSlop={4} style={({ pressed }) => [styles.diff, { backgroundColor: pressed ? c.surface : 'transparent' }]}>
      <Text style={[styles.diffText, { color: c.success }]}>+{totals.added}</Text>
      <Text style={[styles.diffText, { color: c.destructive }]}>−{totals.removed}</Text>
    </Pressable> : null}
    {item.pullRequestId && number ? <Pressable accessibilityRole="button"
      accessibilityLabel={`Pull request ${number}${status ? `. ${status.label}` : ''}. Open the pull request.`}
      onPress={() => router.push(pullRequestRoute(item.pullRequestId!))} hitSlop={6} style={({ pressed }) => [styles.pr, { opacity: pressed ? 0.6 : 1 }]}>
      <PrNumber number={number} tone={tone} />
    </Pressable> : null}
  </>;
}

/**
 * Everything the header no longer shows: full title, repository, branch,
 * update time, agent and model, problems, the PR and the parent thread.
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
  const chat = (item.chats ?? []).find((value) => value.id === selected) ?? item.chats?.[0];
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
      {item.threadId ? <Row divider={false} chevron title="Open parent thread" onPress={() => go(threadRoute(item.threadId!))} /> : null}
    </ScrollView>
  </SheetModal>;
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 6 },
  title: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  diff: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, minHeight: 32, borderRadius: 6 },
  diffText: { fontSize: 12, lineHeight: 16, ...mono(500) },
  pr: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 2 },
  details: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 24, gap: 12 },
  state: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fact: { flexDirection: 'row', gap: 12, paddingVertical: 4 },
  factLabel: { width: 88 },
});
