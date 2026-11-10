import type { CloudProviderInfo, MergeQueueTimelineEvent, PRFile, PRReviewDetail, PRReviewEvent, pullRequests } from '@talyn/client/native';
import { fixBlockedMessage, fixBlockedReason, resolveReportingBar, type CloudAgentChoice, type Environment, type Workspace } from '@talyn/shared';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { ScreenContainer } from '../../components/ScreenContainer';
import { PrStateBadge } from '../../components/Status';
import { AppText, BottomBar, Button, IconButton, Notice, PromptSheet, Row, useActionSheet, useToast, type SheetAction,
  type Symbol } from '../../components/UI';
import { Heading, NativeText, openExternal, safeExternalUrl, StateNotice, workflowStyles as styles } from '../../components/Workflow';
import { trackEvent } from '../../lib/analytics';
import { errorMessage, showActionError } from '../../lib/errors';
import { relativeTimeLabel, shortTime, useNow } from '../../lib/time';
import { completeIntent } from '../../navigation/intents';
import { sessionRoute } from '../../navigation/routes';
import { sans, useTheme, withAlpha, type Theme } from '../../theme/tokens';
import { useResource } from '../../workflow/hooks';
import { stackLabel } from '../../workflow/model';
import { WEB_APP_URL } from '../settings/about';
import { AutomationToggles } from './AutomationToggles';
import { fixAgentChoices, linkedTaskRunning, prActions, startPrFix, type FixOutcome } from './actions';
import { CodeReviewSection, CodeReviewSelectionBar, CodeReviewStartSheet, useCodeReview } from './CodeReviewSection';
import { failingBadge, groupChecks, type PrDetailTab } from './detailModel';
import { pullsRoute } from './lists';
import { prNextStep, type NextStep, type NextStepIcon, type NextStepPrimary, type NextStepTone } from './nextStep';
import { ChecksTab, Description, DetailTabStrip, FilesTab, QueueSection, ReviewsTab, type TabSpec } from './PrDetailTabs';
import { usePrLinkMenu, type PrLinkTarget } from './usePrLinkMenu';

type PrDetail = Awaited<ReturnType<typeof pullRequests.get>>;
type Busy = 'merge' | 'fix' | 'queue' | 'autoKeep' | 'resubmit' | 'hide' | 'review' | null;
/** GitHub refuses a review comment longer than this. */
const MAX_REVIEW_BODY = 65_536;

const STEP_ICON: Record<NextStepIcon, Symbol> = {
  merged: { ios: 'arrow.triangle.merge', android: 'merge' },
  closed: { ios: 'xmark.circle', android: 'cancel' },
  agent: { ios: 'wand.and.stars', android: 'auto_fix_high' },
  queue: { ios: 'list.number', android: 'format_list_numbered' },
  stopped: { ios: 'exclamationmark.octagon', android: 'report' },
  draft: { ios: 'pencil.circle', android: 'draft' },
  conflict: { ios: 'exclamationmark.triangle', android: 'warning' },
  person: { ios: 'person', android: 'person' },
  failed: { ios: 'xmark.circle', android: 'cancel' },
  changes: { ios: 'text.bubble', android: 'rate_review' },
  behind: { ios: 'arrow.down.to.line', android: 'arrow_downward' },
  running: { ios: 'clock', android: 'schedule' },
  review: { ios: 'eye', android: 'visibility' },
  ready: { ios: 'checkmark.circle', android: 'check_circle' },
  info: { ios: 'info.circle', android: 'info' },
};
const PRIMARY_ICON: Record<NextStepPrimary['kind'], Symbol> = {
  merge: { ios: 'arrow.triangle.merge', android: 'merge' },
  fix: { ios: 'wand.and.stars', android: 'auto_fix_high' },
  queue: { ios: 'text.append', android: 'playlist_add' },
  resubmit: { ios: 'arrow.clockwise', android: 'refresh' },
  requeue: { ios: 'arrow.clockwise', android: 'refresh' },
  session: { ios: 'bubble.left.and.text.bubble.right', android: 'forum' },
  review: { ios: 'text.magnifyingglass', android: 'manage_search' },
  findings: { ios: 'text.magnifyingglass', android: 'manage_search' },
  open: { ios: 'safari', android: 'open_in_new' },
  approve: { ios: 'checkmark.circle', android: 'check_circle' },
  request_changes: { ios: 'text.bubble', android: 'rate_review' },
};
const OPEN_ICON: Symbol = { ios: 'safari', android: 'open_in_new' };

function toneColor(c: Theme, tone: NextStepTone) {
  return tone === 'danger' ? c.destructive : tone === 'neutral' ? c.muted : c[tone];
}

/** The verdict, why, and what is blocking it. The one tinted thing on the page. */
function NextStepCard({ step, onChecks }: { step: NextStep; onChecks(): void }) {
  const c = useTheme();
  const color = toneColor(c, step.tone);
  const tint = step.tone === 'neutral' ? { backgroundColor: c.paper, borderColor: c.border }
    : { backgroundColor: withAlpha(color, c.mode === 'dark' ? 0.1 : 0.06), borderColor: withAlpha(color, 0.3) };
  return <View style={[local.card, tint]}>
    <View style={local.cardHead} accessible accessibilityLabel={step.detail ? `${step.verdict}. ${step.detail}` : step.verdict}>
      <SymbolView name={STEP_ICON[step.icon]} size={20} tintColor={color} />
      <View style={{ flex: 1, gap: 2 }}>
        <AppText variant="body" style={sans(600)}>{step.verdict}</AppText>
        {step.detail ? <AppText variant="meta" tone="muted" numberOfLines={3}>{step.detail}</AppText> : null}
      </View>
    </View>
    {step.failing.length ? <View style={local.failing}>
      {step.failing.map((name) => <Pressable key={name} accessibilityRole="button" accessibilityLabel={`${name}. Show checks`} onPress={onChecks}
        style={({ pressed }) => [local.failingRow, { opacity: pressed ? 0.6 : 1 }]}>
        <SymbolView name={{ ios: 'xmark', android: 'close' }} size={12} tintColor={c.destructive} />
        <AppText variant="mono" numberOfLines={1} style={{ flex: 1, fontSize: 12 }}>{name}</AppText>
      </Pressable>)}
    </View> : null}
    {step.session && step.primary?.kind !== 'session'
      ? <Row title="View session" subtitle={step.session.name} href={sessionRoute(step.session.id)} chevron divider={false} /> : null}
  </View>;
}

export function PullRequestDetailScreen() {
  const params = useLocalSearchParams(); const id = typeof params.id === 'string' ? params.id : '';
  const { workflow } = useMobileRuntime();
  const router = useRouter();
  const state = useResource<PrDetail>('pr', id, Boolean(id), true);
  // Draw at once from the list's copy while the current one loads. Actions wait for the current copy.
  const current = Boolean(state.data);
  const seed = state.status === 'deleted' || state.status === 'unauthorized' ? undefined : workflow.listedPr(id);
  const row = state.data?.row ?? seed;
  // The pull-to-refresh spinner says it is loading; a second loading line would only push the page down.
  const seeding = !current && Boolean(seed) && (state.status === 'loading' || state.status === 'idle');
  const fresh = state.data?.fresh ?? null;
  const queued = Boolean(row && (row.mergeQueued || row.mergeQueue));
  const [tab, setTab] = useState<PrDetailTab>('overview');
  const [seen, setSeen] = useState<ReadonlySet<PrDetailTab>>(new Set(['overview']));
  const timeline = useResource<{ events: MergeQueueTimelineEvent[] }>('timeline', id, queued);
  // The live fetch carries the body. The cached copy is only for when it is unavailable.
  const description = useResource<{ body: string | null }>('prDescription', id, Boolean(row) && !fresh);
  const files = useResource<PRFile[]>('prFiles', id, Boolean(row) && seen.has('files'));
  const reviews = useResource<PRReviewDetail>('prReviews', id, Boolean(row) && seen.has('reviews'));
  const writable = Boolean(row?.authored && row.state === 'open');
  const providers = useResource<CloudProviderInfo[]>('providers', '', writable);
  // Also read for the code review's reporting bar, so it is needed on every PR.
  const workspace = useResource<Workspace>('workspace', '', Boolean(row));
  const environments = useResource<Environment[]>('environments', '', writable);
  const offline = useNetwork() === 'offline';
  const now = useNow();
  const colors = useTheme();
  const sheet = useActionSheet();
  const links = usePrLinkMenu();
  const [busy, setBusy] = useState<Busy>(null);
  const [reviewSheet, setReviewSheet] = useState(false);
  const [reviewPrompt, setReviewPrompt] = useState<PRReviewEvent | null>(null);
  const toast = useToast();
  const [taskRunning, setTaskRunning] = useState(false);
  const [notice, setNotice] = useState<{ message: string; session?: { id: string; name: string } } | null>(null);
  useEffect(() => { if (row) completeIntent(`/attention/${encodeURIComponent(id)}`); }, [row, id]);
  useEffect(() => { setNotice(null); setReviewPrompt(null); setTab('overview'); setSeen(new Set(['overview'])); }, [id]);
  const taskId = row?.taskId ?? null;
  useEffect(() => {
    let cancelled = false;
    if (!taskId) { setTaskRunning(false); return undefined; }
    void linkedTaskRunning(workflow, { taskId }).then((running) => { if (!cancelled) setTaskRunning(running); });
    return () => { cancelled = true; };
  }, [workflow, taskId]);
  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!row || openedRef.current === id) return;
    openedRef.current = id;
    const blocked = fixBlockedReason(row.summary, { state: row.state, taskRunning: false });
    const createdAt = row.summary.createdAt ? new Date(row.summary.createdAt).getTime() : Number.NaN;
    trackEvent('pr_detail_opened', {
      pr_number: row.number,
      ...(Number.isFinite(createdAt) ? { age_hours: Math.round((Date.now() - createdAt) / 3_600_000) } : {}),
      blocking_reason: row.summary.blockingReason,
      can_dispatch: blocked === null,
      ...(blocked ? { dispatch_blocked_reason: blocked } : {}),
      ...(providers.data ? { has_agent: providers.data.some((provider) => provider.connected) } : {}),
    });
  }, [row, id, providers.data]);
  const codeReview = useCodeReview(id, { seed: row?.codeReview, enabled: Boolean(row),
    reportingBar: resolveReportingBar(workspace.data?.settings?.codeReview) });

  const summary = fresh ?? row?.summary;
  const posthogConnected = (providers.data ?? []).some((provider) => provider.type === 'posthog_code' && provider.connected);
  const actions = row ? prActions(row, { posthogConnected, taskRunning }) : null;
  const reviewState = !codeReview.review ? 'none' as const : codeReview.running ? 'running' as const : 'ready' as const;
  const step = row && summary && actions ? prNextStep({ row, summary, actions, checkContexts: fresh?.checkContexts,
    recentReviews: fresh?.recentReviews, taskRunning, codeReview: reviewState, now }) : null;
  const checkGroups = useMemo(() => groupChecks(fresh?.checkContexts, summary?.blockingReason), [fresh?.checkContexts, summary?.blockingReason]);
  const updated = summary?.updatedAt ?? row?.updatedAt;
  const url = summary ? safeExternalUrl(summary.url) : null;
  const ref = row ? `#${row.number}` : '';
  const linkTarget: PrLinkTarget | null = row && url ? { title: summary?.title ?? '', url, ref: `${row.owner}/${row.repo} #${row.number}` } : null;
  const busyAny = busy !== null || offline || !current;
  const canReview = Boolean(row && row.state === 'open' && row.reviewRequested && !row.authored);
  const selectionBar = codeReview.selected.size > 0 && !codeReview.fixing;

  const selectTab = (next: PrDetailTab) => {
    setTab(next);
    setSeen((prev) => prev.has(next) ? prev : new Set([...prev, next]));
  };
  const run = async (kind: Exclude<Busy, null>, title: string, action: () => Promise<void>) => {
    setBusy(kind);
    try { await action(); } catch (error) { showActionError(title, error); } finally { setBusy(null); }
  };
  const merge = () => {
    if (!row || !summary) return;
    Alert.alert(`Merge ${ref}?`, `Squash-merge "${summary.title}" into ${summary.baseBranch || 'its base branch'} on GitHub.`, [
      { text: 'Cancel', style: 'cancel', isPreferred: true },
      { text: 'Merge', onPress: () => void run('merge', `Could not merge ${ref}`, async () => {
        const result = await workflow.mergePr(row.id);
        if (result.submitted) {
          trackEvent('pr_submitted_external_queue', { pr_number: row.number, via: result.via ?? 'auto_merge' });
        }
        if (result.submitted) setNotice({ message: `Submitted ${ref} to the merge queue. ${result.message}`.trim() });
        else if (result.alreadyTerminal) setNotice({ message: `${ref} was already ${result.merged ? 'merged' : 'closed'}.` });
        else if (!result.merged) throw new Error(result.message || 'GitHub did not merge the pull request.');
        else {
          trackEvent('pr_merged', { source: 'manual', pr_number: row.number, blocking_reason: row.summary.blockingReason });
          setNotice({ message: `Merged ${ref}.` });
        }
      }) },
    ]);
  };
  const fix = (choice?: CloudAgentChoice) => {
    if (!row) return;
    void run('fix', `Could not start a run on ${ref}`, async () => {
      const outcome: FixOutcome = await startPrFix(workflow, row, { providers: providers.data ?? [], environments: environments.data ?? [],
        workspace: workspace.data, choice });
      if (outcome.kind === 'blocked') Alert.alert('Nothing to hand to an agent', fixBlockedMessage(outcome.reason));
      else if (outcome.kind === 'no_agent') Alert.alert('Connect an agent', 'Connect your Claude or ChatGPT subscription in Talyn on the web, in Settings, Integrations.', [
        { text: 'Close', style: 'cancel' }, { text: 'Open Talyn on the web', onPress: () => openExternal(WEB_APP_URL) },
      ]);
      else if (outcome.kind === 'session') setNotice({ message: `Sent to the session ${outcome.name}.`, session: outcome });
      else {
        trackEvent('pr_fix_task_started', { pr_number: row.number, blocking_reason: row.summary.blockingReason });
        setNotice({ message: 'An agent is working on this pull request.' });
      }
    });
  };
  const pickAgent = () => {
    const choices = fixAgentChoices(providers.data ?? [], workspace.data);
    if (row?.session || !choices.length) { fix(); return; }
    sheet.open({ title: 'Fix with which agent?', actions: choices.map((choice) => ({
      label: choice.displayName, detail: choice.models.find((model) => model.id === choice.model)?.label, onPress: () => fix(choice),
    })) });
  };
  const pressFix = () => {
    if (!actions?.fixBlocked) { pickAgent(); return; }
    if (row) trackEvent('pr_fix_blocked', { source: 'pr_detail', reason: actions.fixBlocked, pr_number: row.number, blocking_reason: row.summary.blockingReason });
    Alert.alert('Nothing to hand to an agent', fixBlockedMessage(actions.fixBlocked));
  };
  const toggleQueue = (enabled: boolean) => row && void run('queue', `Could not ${enabled ? 'queue' : 'dequeue'} ${ref}`,
    async () => {
      await workflow.setMergeQueue(row.id, enabled);
      trackEvent('merge_queue_toggled', { enabled, pr_number: row.number });
    });
  const toggleAutoKeep = (enabled: boolean) => row && void run('autoKeep', 'Could not change auto-keep',
    () => workflow.setAutoKeep(row.id, enabled));
  const resubmit = () => row && void run('resubmit', 'Could not re-submit to Trunk', async () => {
    try { await workflow.resubmitMergeQueue(row.id); setNotice({ message: 'Re-submitted to Trunk.' }); }
    catch (error) { throw new Error(errorMessage(error, 'Please try again.')); }
  });
  const requeue = () => row && void run('queue', `Could not requeue ${ref}`, async () => {
    await workflow.setMergeQueue(row.id, true);
    trackEvent('merge_queue_toggled', { enabled: true, pr_number: row.number });
  });
  const toggleHidden = () => row && void run('hide', 'Could not change the review request', async () => {
    const hide = !row.reviewHiddenAt;
    await workflow.setReviewHidden(row.id, hide);
    setNotice({ message: hide ? 'Hidden from your review requests.' : 'Back in your review requests.' });
  });
  const submitReview = (event: PRReviewEvent, body: string) => row && void run('review',
    event === 'approve' ? `Could not approve ${ref}` : `Could not request changes on ${ref}`, async () => {
      await workflow.submitPrReview(row.id, event, body || undefined);
      trackEvent('pr_review_submitted', { event, has_comment: Boolean(body.trim()) });
      setReviewPrompt(null);
      toast.show(event === 'approve' ? 'Approved.' : 'Changes requested.');
    });
  const refreshAll = () => {
    void state.refresh(); void codeReview.state.refresh();
    if (queued) void timeline.refresh();
    if (!fresh && row) void description.refresh();
    if (seen.has('files')) void files.refresh();
    if (seen.has('reviews')) void reviews.refresh();
  };
  const runPrimary = (primary: NextStepPrimary) => {
    switch (primary.kind) {
      case 'merge': merge(); break;
      case 'fix': pressFix(); break;
      case 'queue': toggleQueue(true); break;
      case 'resubmit': resubmit(); break;
      case 'requeue': requeue(); break;
      case 'session': if (step?.session) router.push(sessionRoute(step.session.id)); break;
      case 'review': setReviewSheet(true); break;
      case 'findings': selectTab('findings'); break;
      case 'open': if (url) openExternal(url); break;
      case 'approve': setReviewPrompt('approve'); break;
      case 'request_changes': setReviewPrompt('request_changes'); break;
    }
  };

  const openMenu = () => {
    if (!row || !actions) return;
    const kind = step?.primary?.kind;
    const items: SheetAction[] = [...links.actions(linkTarget)];
    if (actions.fix && kind !== 'fix') items.push({ label: 'Fix with agent', icon: PRIMARY_ICON.fix, disabled: busyAny,
      detail: actions.fixBlocked ? fixBlockedMessage(actions.fixBlocked) : undefined, onPress: pressFix });
    if (actions.merge && kind !== 'merge') items.push({ label: 'Merge', icon: PRIMARY_ICON.merge, disabled: busyAny, onPress: merge });
    if (row.state === 'open' && kind !== 'review') items.push({ label: 'Review with Talyn', icon: PRIMARY_ICON.review, onPress: () => setReviewSheet(true) });
    if (actions.queue) items.push({ label: row.mergeQueued ? 'Leave merge queue' : 'Add to merge queue', icon: PRIMARY_ICON.queue,
      disabled: busyAny, onPress: () => toggleQueue(!row.mergeQueued) });
    if (actions.resubmit && kind !== 'resubmit') items.push({ label: 'Re-submit to Trunk', icon: PRIMARY_ICON.resubmit, disabled: busyAny, onPress: resubmit });
    else if (actions.requeue && kind !== 'requeue') items.push({ label: 'Requeue', icon: PRIMARY_ICON.requeue, disabled: busyAny, onPress: requeue });
    if (actions.autoKeep) items.push({ label: row.autoKeepMergeable ? 'Turn off Keep mergeable' : 'Turn on Keep mergeable',
      icon: { ios: 'shield.lefthalf.filled', android: 'shield' }, disabled: busyAny, onPress: () => toggleAutoKeep(!row.autoKeepMergeable) });
    // Shown here when the bar does not offer them: a selection bar replaces it, or another state comes first.
    const inBar = !selectionBar && (kind === 'approve' || step?.secondary?.kind === 'request_changes');
    if (canReview && !inBar) items.push(
      { label: 'Approve', icon: PRIMARY_ICON.approve, disabled: busyAny, onPress: () => setReviewPrompt('approve') },
      { label: 'Request changes', icon: PRIMARY_ICON.request_changes, disabled: busyAny, onPress: () => setReviewPrompt('request_changes') });
    if (row.reviewRequested && !row.authored) items.push({ label: row.reviewHiddenAt ? 'Show in review requests' : 'Hide review request',
      icon: { ios: 'eye.slash', android: 'visibility_off' }, disabled: busyAny, onPress: toggleHidden });
    items.push({ label: 'Refresh', icon: { ios: 'arrow.clockwise', android: 'refresh' }, disabled: offline, onPress: refreshAll });
    sheet.open({ title: summary?.title || 'Pull request', message: linkTarget?.ref, actions: items });
  };

  const tabs: TabSpec[] = [];
  if (row && summary) {
    const failing = failingBadge(checkGroups, (fresh?.checks ?? row.summary.checks)?.failed ?? 0);
    const fileCount = files.data?.length ?? summary.changedFiles;
    const reviewCount = fresh?.recentReviews.length;
    tabs.push({ key: 'overview', label: 'Overview' },
      { key: 'checks', label: 'Checks', badge: failing > 0 ? String(failing) : undefined },
      { key: 'files', label: 'Files', badge: fileCount === undefined ? undefined : String(fileCount) },
      { key: 'reviews', label: 'Reviews', badge: reviewCount ? String(reviewCount) : undefined });
    if (codeReview.review) tabs.push({ key: 'findings', label: 'Findings', badge: codeReview.review.openCount ? String(codeReview.review.openCount) : undefined });
  }
  const shownTab = tab === 'findings' && !codeReview.review ? 'overview' : tab;
  const primary = step?.primary ?? null;
  const secondary = primary && primary.kind !== 'open' ? step?.secondary ?? null : null;
  const primaryBusy = primary && ({ merge: 'merge', fix: 'fix', queue: 'queue', requeue: 'queue', resubmit: 'resubmit', approve: 'review',
    request_changes: 'review' } as Partial<Record<NextStepPrimary['kind'], Busy>>)[primary.kind];
  const primaryButton = primary ? <Button title={primary.label} variant={primary.kind === 'merge' ? 'success' : 'primary'} icon={PRIMARY_ICON[primary.kind]}
    loading={Boolean(primaryBusy) && busy === primaryBusy} disabled={Boolean(primary.disabledReason) || (Boolean(primaryBusy) && busyAny)}
    accessibilityLabel={primary.disabledReason ? `${primary.label}. ${primary.disabledReason}` : primary.label} onPress={() => runPrimary(primary)} /> : null;
  const stack = row ? stackLabel(row) : '';

  return <ScreenContainer>
    {row ? <Stack.Screen options={{
      headerRight: () => <IconButton label="Pull request actions" symbol={{ ios: 'ellipsis.circle', android: 'more_vert' }} onPress={openMenu} />,
    }} /> : null}
    <ScrollView contentContainerStyle={[styles.content, local.content]}
      refreshControl={<RefreshControl refreshing={(state.refreshing || seeding) && Boolean(row)} onRefresh={refreshAll}
        tintColor={colors.muted} colors={[colors.primaryAction]} />}>
      {seeding ? null : <StateNotice resource={state} offline={offline} refresh={state.refresh} />}
      {row && summary && actions && step ? <>
        <View style={local.header}>
          <Heading size="heading">{summary.title || 'Pull request'}</Heading>
          <View style={local.meta}>
            <PrStateBadge state={row.state} draft={summary.draft} />
            <AppText variant="meta" tone="muted" numberOfLines={2} style={{ flexShrink: 1 }}
              accessibilityLabel={`${row.owner}/${row.repo} pull request ${row.number}, by ${summary.author || 'unknown author'}${updated ? `, updated ${relativeTimeLabel(updated, now)}` : ''}`}>
              {`${row.owner}/${row.repo} #${row.number} · ${summary.author || 'Unknown author'}${updated ? ` · ${shortTime(updated, now)}` : ''}`}
            </AppText>
          </View>
          {summary.headBranch ? <AppText variant="mono" tone="muted" numberOfLines={1} ellipsizeMode="middle" style={{ fontSize: 12 }}>
            {`${summary.headBranch} → ${summary.baseBranch}`}</AppText> : null}
        </View>
        <NextStepCard step={step} onChecks={() => selectTab('checks')} />
        <AutomationToggles row={row} queue={Boolean(actions.queue)} autoKeep={Boolean(actions.autoKeep)} disabled={busyAny}
          onQueue={toggleQueue} onAutoKeep={toggleAutoKeep} />
        {notice ? <Notice message={notice.message} tone="success">
          {notice.session ? <Row title={`Open ${notice.session.name}`} href={sessionRoute(notice.session.id)} chevron divider={false} /> : null}
        </Notice> : null}

        <DetailTabStrip tabs={tabs} value={shownTab} onChange={selectTab} />
        {!fresh && state.status === 'ready' ? <AppText variant="caption" tone="muted">Live detail from GitHub is unavailable. Showing the last saved state.</AppText> : null}

        {shownTab === 'overview' ? <View style={local.tab}>
          <Description body={(fresh ? fresh.body : description.data?.body) ?? ''}
            loading={!fresh && !description.data && (description.status === 'loading' || description.status === 'idle')} />
          {stack !== 'Standalone' && stack !== 'Unknown' ? <AppText variant="meta" tone="muted">Stack: {stack}</AppText> : null}
          {row.autoMergeState?.needsHuman ? <NativeText text={row.autoMergeState.needsHuman.reason} /> : null}
          {queued ? <QueueSection entry={row.mergeQueue} sessionName={row.session?.name} timeline={timeline} offline={offline} now={now} /> : null}
        </View> : null}
        {shownTab === 'checks' ? <ChecksTab contexts={fresh?.checkContexts} checks={fresh?.checks ?? row.summary.checks}
          blockingReason={summary.blockingReason} humanGates={summary.humanGates} url={url} /> : null}
        {shownTab === 'files' ? <FilesTab files={files} offline={offline} url={url} /> : null}
        {shownTab === 'reviews' ? <ReviewsTab reviews={reviews} offline={offline} url={url} now={now} /> : null}
        {shownTab === 'findings' ? <CodeReviewSection review={codeReview} open={row.state === 'open'} openSheet={sheet.open}
          onReviewRequest={() => setReviewSheet(true)} /> : null}
      </> : state.status === 'deleted' || state.status === 'unauthorized'
        ? <Row title="Back to pull requests" href={pullsRoute('mine')} chevron divider={false} /> : null}
    </ScrollView>
    {row && selectionBar ? <CodeReviewSelectionBar review={codeReview} />
      : row && step ? <BottomBar>
        {primary && primary.kind !== 'open' ? <>
          <View style={{ flex: 1, gap: 4 }}>
            {primary.disabledReason ? <AppText variant="caption" tone="muted" numberOfLines={2}>{primary.disabledReason}</AppText> : null}
            {secondary ? <View style={local.barButtons}>
              <View style={{ flex: 1 }}><Button variant="secondary" title={secondary.label} disabled={busyAny} onPress={() => runPrimary(secondary)} /></View>
              <View style={{ flex: 1 }}>{primaryButton}</View>
            </View> : primaryButton}
          </View>
          {url ? <IconButton label="Open pull request website" symbol={OPEN_ICON} onPress={() => openExternal(url)} /> : null}
        </> : url ? <View style={{ flex: 1 }}><Button variant={primary ? 'primary' : 'secondary'} title="Open on GitHub"
          accessibilityLabel="Open pull request website" icon={OPEN_ICON} onPress={() => openExternal(url)} /></View> : null}
      </BottomBar> : null}
    <PromptSheet visible={reviewPrompt !== null} busy={busy === 'review'} maxLength={MAX_REVIEW_BODY} multiline
      title={reviewPrompt === 'request_changes' ? `Request changes on ${ref}` : `Approve ${ref}`}
      message={reviewPrompt === 'request_changes' ? 'Say what to change. GitHub needs a comment to request changes.' : 'A comment is optional.'}
      label={reviewPrompt === 'request_changes' ? 'What to change' : 'Comment (optional)'}
      placeholder={reviewPrompt === 'request_changes' ? 'What to change' : 'Add a comment'}
      optional={reviewPrompt !== 'request_changes'} submitLabel={reviewPrompt === 'request_changes' ? 'Request changes' : 'Approve'}
      onCancel={() => setReviewPrompt(null)} onSubmit={(value) => { if (reviewPrompt) submitReview(reviewPrompt, value); }} />
    <CodeReviewStartSheet review={codeReview} visible={reviewSheet} onClose={() => setReviewSheet(false)} onStarted={() => selectTab('findings')} />
    {links.toast}
    {toast.element}
    {sheet.sheet}
  </ScreenContainer>;
}

const local = StyleSheet.create({
  content: { gap: 14 },
  header: { gap: 4 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 12, gap: 8 },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  failing: { gap: 2, paddingLeft: 30 },
  failingRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 28 },
  tab: { gap: 14 },
  barButtons: { flexDirection: 'row', gap: 8 },
});
