import type { PRRow } from '@talyn/client/native';
import type { Workbench } from '@talyn/shared';
import { useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { PrPill, PrReviewPill, PrStatusPill } from '../../components/Status';
import { AppText, Button, Group, Row, type SheetRequest } from '../../components/UI';
import { openExternal, safeExternalUrl, StateNotice } from '../../components/Workflow';
import { errorMessage, showActionError } from '../../lib/errors';
import { prRowStatus } from '../../lib/status';
import { pullRequestRoute } from '../../navigation/routes';
import { useTheme } from '../../theme/tokens';
import { useResource } from '../../workflow/hooks';
import { checksLine, mergeLine } from '../prs/actions';
import { canCreatePullRequest, sessionUnavailable } from './model';
import { sendCreatePullRequest } from './sessionPrActions';

type PrDetail = { row: PRRow };

const LOCAL_LINK = 'This session runs on a computer with the Talyn desktop app. Link the pull request there.';

function LinkedPullRequest({ item }: { item: Workbench }) {
  const id = item.pullRequestId ?? '';
  const state = useResource<PrDetail>('pr', id, Boolean(id));
  const offline = useNetwork() === 'offline';
  const c = useTheme();
  const row = state.data?.row;
  const fallback = item.pr;
  if (!row) {
    return <View style={{ gap: 8 }}>
      <StateNotice resource={state} offline={offline} refresh={state.refresh} />
      {fallback ? <Group><Row title="Loading the pull request" href={pullRequestRoute(id)} chevron divider={false}
        trailing={<PrPill number={fallback.number} state={fallback.state} />} /></Group> : null}
    </View>;
  }
  const summary = row.summary;
  const status = prRowStatus(row);
  const checks = checksLine(summary.checks);
  const url = safeExternalUrl(summary.url);
  return <View style={{ gap: 12 }}>
    {state.status === 'error' || offline ? <StateNotice resource={state} offline={offline} refresh={state.refresh} /> : null}
    <Group>
      <Row title={summary.title} href={pullRequestRoute(row.id)} chevron divider={false} titleLines={3}
        accessibilityLabel={`Pull request ${row.number}: ${summary.title}. ${status.label}. Open the pull request.`}
        trailing={<PrPill number={row.number} state={row.state} draft={summary.draft} />}>
        <View style={styles.pills}>
          <PrStatusPill variant={status} />
          {row.state === 'open' ? <PrReviewPill decision={summary.effectiveReviewDecision ?? summary.reviewDecision} state={row.state} /> : null}
        </View>
        {checks ? <AppText variant="meta" tone="muted">{checks}</AppText> : null}
        <AppText variant="meta" tone="muted">{row.state === 'merged' && summary.baseBranch ? `Merged into ${summary.baseBranch}.` : mergeLine(row, summary)}</AppText>
        <AppText variant="caption" style={{ color: c.muted }}>{`${summary.headBranch} → ${summary.baseBranch}`}</AppText>
      </Row>
    </Group>
    {url ? <View style={{ alignSelf: 'flex-start' }}>
      <Button variant="quiet" size="sm" icon={{ ios: 'arrow.up.right.square', android: 'open_in_new' }} title="Open on GitHub" onPress={() => openExternal(url)} />
    </View> : null}
  </View>;
}

function NoPullRequest({ item, openSheet, onSent }: { item: Workbench; openSheet(request: SheetRequest): void; onSent(message: string): void }) {
  const { workflow } = useMobileRuntime();
  const offline = useNetwork() === 'offline';
  const [busy, setBusy] = useState<'create' | 'link' | null>(null);
  const unavailable = sessionUnavailable(item);
  const creatable = canCreatePullRequest(item);

  const create = async () => {
    setBusy('create');
    try {
      onSent(await sendCreatePullRequest(workflow, item));
    } catch (error) {
      showActionError('Could not create the pull request', error);
    } finally {
      setBusy(null);
    }
  };

  const link = async (number: number) => {
    setBusy('link');
    try {
      const result = await workflow.api.workbenches.linkPullRequest(item.id, number);
      if (result.needsCheckout) {
        await workflow.api.workbenches.unlinkPullRequest(item.id);
        throw new Error(LOCAL_LINK);
      }
      workflow.applyWorkbench(result.workbench);
    } catch (error) {
      showActionError('Could not link the pull request', error);
      workflow.refresh('workbench', item.id);
    } finally {
      setBusy(null);
    }
  };

  const chooseLink = async () => {
    setBusy('link');
    try {
      const choices = await workflow.api.workbenches.openPullRequests(item.id, { state: 'open' });
      if (!choices.length) { Alert.alert('No open pull requests', 'This repository has no open pull request to link.'); return; }
      openSheet({
        title: 'Link pull request',
        message: 'The session follows the pull request you choose.',
        actions: choices.map((choice) => ({
          label: `#${choice.number} ${choice.title}`,
          detail: [choice.headRef, choice.author, choice.draft ? 'Draft' : ''].filter(Boolean).join(' · '),
          onPress: () => { void link(choice.number); },
        })),
      });
    } catch (error) {
      Alert.alert('Could not load pull requests', errorMessage(error, 'Please try again.'));
    } finally {
      setBusy(null);
    }
  };

  return <View style={{ gap: 12 }}>
    <View style={{ gap: 4 }}>
      <AppText variant="rowTitle">No pull request yet</AppText>
      <AppText variant="meta" tone="muted">
        {creatable ? 'Ask the agent to write the pull request. Talyn then commits, pushes and opens it.'
          : 'Checks and reviews show here once this branch has a pull request.'}
      </AppText>
      {unavailable ? <AppText variant="meta" tone="warning">{unavailable}</AppText> : null}
    </View>
    {creatable ? <Button title="Create pull request" icon={{ ios: 'arrow.triangle.pull', android: 'fork_right' }}
      loading={busy === 'create'} disabled={busy !== null || offline || Boolean(unavailable)} onPress={() => { void create(); }} /> : null}
    {item.runtime === 'sandbox' ? <Button variant="secondary" title="Link an existing pull request" loading={busy === 'link'}
      disabled={busy !== null || offline} onPress={() => { void chooseLink(); }} /> : null}
    {offline ? <AppText variant="meta" tone="muted">You are offline.</AppText> : null}
  </View>;
}

/**
 * The pull request view: the linked pull request's status, review and checks,
 * opening the full PR screen; or, with none yet, Create PR and Link like web.
 */
export function PullRequestTab({ item, openSheet, onSent }: {
  item: Workbench; openSheet(request: SheetRequest): void;
  /** Called after Create PR was sent, with the words to confirm it. */
  onSent(message: string): void;
}) {
  const { workflow } = useMobileRuntime();
  const c = useTheme();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    setRefreshing(true);
    const loads = [workflow.load('workbench', item.id)];
    if (item.pullRequestId) loads.push(workflow.load('pr', item.pullRequestId));
    void Promise.all(loads).finally(() => setRefreshing(false));
  };
  return <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.muted} colors={[c.primaryAction]} progressBackgroundColor={c.elevated} />}>
    {item.pullRequestId ? <LinkedPullRequest item={item} /> : <NoPullRequest item={item} openSheet={openSheet} onSent={onSent} />}
  </ScrollView>;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40, gap: 12 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
});
