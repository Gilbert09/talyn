import { useLocalSearchParams } from 'expo-router';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { PRRow, MergeQueueTimelineEvent, pullRequests } from '@talyn/client/native';
import type { Workbench, WorkbenchReadiness } from '@talyn/shared';

import { useMobileRuntime, useNetwork, useWorkspace } from '../auth/AuthProvider';
import { ShellLink, useShellColors } from '../components/ShellScreen';
import { Action, Body, CardLink, Heading, NativeText, openExternal, safeExternalUrl, StateNotice, workflowStyles as styles } from '../components/Workflow';
import { completeIntent } from '../navigation/intents';
import { pullRequestRoute, sessionRoute, threadRoute } from '../navigation/routes';
import { useLocal, useResource } from './hooks';
import { canCompose, ciLabel, deliveryLabel, externalLabel, mergeabilityLabel, mergeStateLabel, queueLabel, reviewLabel, humanGate, needsAttention, stackLabel, statusLabel, transcriptRows,
  workbenchKind, workbenchTitle, type Transcript, type TranscriptRow } from './model';

export function dateLabel(value: string | null | undefined) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Time unavailable';
}
function workbenchSummary(item: Workbench) {
  return [item.repoFullName || 'Workspace scope', statusLabel(item.status),
    item.chats?.some((chat) => chat.status === 'running') ? 'Agent running' : '', humanGate(item) ? 'Response needed' : '',
    `Updated ${dateLabel(item.updatedAt)}`].filter(Boolean).join(' · ');
}
function WorkbenchLink({ item }: { item: Workbench }) {
  return <CardLink href={workbenchKind(item) === 'thread' ? threadRoute(item.id) : sessionRoute(item.id)}
    title={workbenchTitle(item)} detail={workbenchSummary(item)} />;
}
function WorkspaceLink() {
  const workspace = useWorkspace();
  return <ShellLink href="/workspaces" label={`Workspace: ${workspace.choices.find((choice) => choice.id === workspace.selected)?.name ?? 'Choose workspace'}`} />;
}
export function WorkbenchListScreen({ kind }: { kind: 'session' | 'thread' }) {
  const entity = kind === 'session' ? 'sessions' : 'threads';
  const title = kind === 'session' ? 'Sessions' : 'Threads';
  const state = useResource<Workbench[]>(entity);
  const offline = useNetwork() === 'offline';
  const colors = useShellColors();
  const { workflow } = useMobileRuntime();
  const positionKey = `list:${entity}`;
  const position = workflow.local(positionKey).offset;
  return <SafeAreaView edges={['left', 'right', 'bottom']} style={[styles.page, { backgroundColor: colors.background }]}>
    <FlatList data={state.data ?? []} keyExtractor={(item) => item.id} accessibilityRole="list" accessibilityLabel={title}
      initialNumToRender={12} maxToRenderPerBatch={10} windowSize={7} contentContainerStyle={styles.content}
      contentOffset={{ x: 0, y: position }} scrollEventThrottle={150}
      onScroll={(event) => workflow.updateLocal(positionKey, { offset: event.nativeEvent.contentOffset.y })}
      refreshing={state.refreshing} onRefresh={() => { void state.refresh(); }}
      ListHeaderComponent={<View style={styles.header}><Heading>{title}</Heading><WorkspaceLink />
        <StateNotice resource={state} offline={offline} refresh={state.refresh} /></View>}
      ListEmptyComponent={state.status === 'ready' ? <Body>{kind === 'session' ? 'No current sessions in this workspace.' : 'No planning threads in this workspace.'}</Body> : undefined}
      renderItem={({ item }) => <WorkbenchLink item={item} />} />
  </SafeAreaView>;
}
function prSummary(row: PRRow) {
  return [`${row.owner}/${row.repo} #${row.number}`, `By ${row.summary.author || 'Unknown'}`,
    `Review: ${reviewLabel(row.summary.effectiveReviewDecision ?? row.summary.reviewDecision)}`,
    `CI: ${ciLabel(row.summary.ciStatus)}`, row.summary.humanGates?.length ? 'Human action needed' : '',
    `Updated ${dateLabel(row.summary.updatedAt ?? row.updatedAt)}`].filter(Boolean).join(' · ');
}
function PrLink({ row }: { row: PRRow }) { return <CardLink href={pullRequestRoute(row.id)} title={row.summary.title || `Pull request #${row.number}`} detail={prSummary(row)} />; }
export function AttentionScreen() {
  const state = useResource<PRRow[]>('attention');
  const offline = useNetwork() === 'offline'; const colors = useShellColors();
  const [all, setAll] = useState(false);
  const { workflow } = useMobileRuntime();
  const rows = (state.data ?? []).filter((row) => all || needsAttention(row)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return <SafeAreaView edges={['left', 'right', 'bottom']} style={[styles.page, { backgroundColor: colors.background }]}>
    <FlatList data={rows} keyExtractor={(item) => item.id} accessibilityRole="list" accessibilityLabel="Pull requests that need attention"
      initialNumToRender={12} maxToRenderPerBatch={10} windowSize={7} contentContainerStyle={styles.content}
      contentOffset={{ x: 0, y: workflow.local('list:attention').offset }} scrollEventThrottle={150}
      onScroll={(event) => workflow.updateLocal('list:attention', { offset: event.nativeEvent.contentOffset.y })}
      refreshing={state.refreshing} onRefresh={() => { void state.refresh(); }}
      ListHeaderComponent={<View style={styles.header}><Heading>Attention</Heading><WorkspaceLink />
        <Body>Read pull request status. Reviews and merge actions are available in Talyn on the web.</Body>
        <Action label={all ? 'Show attention only' : 'Show all open pull requests'} onPress={() => setAll(!all)} />
        <StateNotice resource={state} offline={offline} refresh={state.refresh} /></View>}
      ListEmptyComponent={state.status === 'ready' ? <Body>{all ? 'No open pull requests.' : 'No pull requests need your action.'}</Body> : undefined}
      renderItem={({ item }) => <PrLink row={item} />} />
  </SafeAreaView>;
}

function Composer({ item, chatId, current }: { item: Workbench; chatId: string; current: boolean }) {
  const { workflow } = useMobileRuntime();
  const local = useLocal(chatId); const colors = useShellColors(); const network = useNetwork();
  const chat = item.chats?.find((value) => value.id === chatId);
  const allowed = current && network === 'online' && canCompose(item, chat) && workflow.canSend();
  const delivery = local.delivery;
  const retry = () => Alert.alert('Send this message again?', delivery.status === 'unknown'
    ? 'Delivery is still unknown. The server can receive the same message twice. Check the conversation and queue first.'
    : 'This sends the current draft again.', [
      { text: 'Cancel', style: 'cancel', isPreferred: true },
      { text: 'Send again', onPress: () => { void workflow.send(item.id, chatId, true); } },
    ]);
  return <ScrollView style={{ maxHeight: '50%', flexGrow: 0, backgroundColor: colors.background }} contentContainerStyle={styles.footer} keyboardShouldPersistTaps="handled">
    {chat?.status === 'awaiting_input' ? <Body>A text response is needed. Permission and terminal actions need Talyn on the web.</Body> : null}
    {chat?.queuedMessages.length ? <Body label={`Server queue: ${chat.queuedMessages.length} messages`}>Server queue: {chat.queuedMessages.length} messages</Body> : null}
    <TextInput multiline accessibilityLabel="Message" accessibilityHint="Text only. Drafts stay in memory in this account and workspace."
      value={local.draft} maxLength={20000} onChangeText={(draft) => workflow.updateLocal(chatId, { draft })}
      editable={delivery.status !== 'sending'} placeholder="Write a message" placeholderTextColor={colors.muted}
      style={[styles.input, { color: colors.text, borderColor: colors.muted, backgroundColor: colors.card }]} />
    {network !== 'online' ? <Body>Sending needs a confirmed internet connection.</Body> : null}
    {!current ? <Body>Refresh current session state before sending.</Body> : null}
    {delivery.status !== 'idle' ? <Text accessibilityLiveRegion="polite" accessibilityRole="status" style={{ color: colors.text, fontSize: 17 }}>{deliveryLabel(delivery.status)}</Text> : null}
    {delivery.status === 'unknown' ? <><Body>Delivery is unknown. Messages are never resent automatically.</Body>
      <Action label="Check delivery" disabled={!allowed} onPress={() => { void workflow.checkDelivery(item.id, chatId); }} />
      {delivery.checked ? <><Body>History and server queue were refreshed. Delivery remains unknown.</Body>
        <Action label="Review and resend" disabled={!allowed || !local.draft.trim()} onPress={retry} /></> : null}</>
      : delivery.status === 'failed' ? <Action label="Retry message" disabled={!allowed || !local.draft.trim()} onPress={retry} />
        : <Action label="Send message" disabled={!allowed || !local.draft.trim() || delivery.status === 'sending'} onPress={() => { void workflow.send(item.id, chatId); }} />}
  </ScrollView>;
}
function TranscriptCard({ row }: { row: TranscriptRow }) {
  const colors = useShellColors();
  return <View style={[styles.transcript, { backgroundColor: colors.card }]} accessibilityLiveRegion="none">
    <Body muted>{row.author} · {dateLabel(row.timestamp)}{row.streaming ? ' · Streaming' : ''}</Body>
    <NativeText text={row.text} />
  </View>;
}
type DetailRow = { kind: 'child'; item: Workbench; key: string } | { kind: 'event'; row: TranscriptRow; key: string };
function Conversation({ item, stale, header, childrenItems }: { item: Workbench; stale: boolean; header: ReactNode; childrenItems: Workbench[] }) {
  const { workflow } = useMobileRuntime();
  const [selected, setSelected] = useState<string | null>(() => workflow.local(`selected:${item.id}`).selectedChat);
  const chats = item.chats ?? [];
  const chat = chats.find((value) => value.id === selected) ?? chats[0];
  const state = useResource<Transcript>('transcript', chat?.id ?? '', Boolean(chat));
  const offline = useNetwork() === 'offline';
  const local = useLocal(chat?.id ?? '');
  const ref = useRef<FlatList<DetailRow>>(null);
  const following = useRef(local.following);
  useLayoutEffect(() => { following.current = workflow.local(chat?.id ?? '').following; }, [workflow, chat?.id]);
  const rows = useMemo(() => transcriptRows(chat?.id ?? '', state.data?.events ?? []), [chat?.id, state.data]);
  useEffect(() => { if (chat) workflow.updateLocal(`selected:${item.id}`, { selectedChat: chat.id }); }, [workflow, item.id, chat?.id]);
  const detailRows: DetailRow[] = [...childrenItems.map((child) => ({ kind: 'child' as const, item: child, key: `child:${child.id}` })),
    ...rows.map((row) => ({ kind: 'event' as const, row, key: row.key })),
    ...(chat?.queuedMessages ?? []).map((message) => ({ kind: 'event' as const, key: `queue:${message.id}`,
      row: { key: `queue:${message.id}`, author: message.origin === 'talyn' ? 'System' as const : 'You' as const,
        timestamp: message.queuedAt, text: `Queued on server\n${message.text}`, streaming: false } }))];
  return <View style={{ flex: 1 }}>
    <FlatList ref={ref} key={chat?.id ?? item.id} data={detailRows} keyExtractor={(row) => row.key} accessibilityRole="list" accessibilityLabel="Conversation transcript"
      initialNumToRender={12} maxToRenderPerBatch={10} windowSize={7} contentContainerStyle={styles.content}
      contentOffset={{ x: 0, y: local.offset }} scrollEventThrottle={150}
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      onScroll={(event) => {
        const native = event.nativeEvent;
        following.current = native.contentSize.height - native.layoutMeasurement.height - native.contentOffset.y < 64;
        workflow.updateLocal(chat?.id ?? item.id, { offset: native.contentOffset.y, following: following.current });
      }}
      onContentSizeChange={() => { if (following.current) ref.current?.scrollToEnd({ animated: false }); }}
      refreshing={state.refreshing} onRefresh={() => { void state.refresh(); }}
      ListHeaderComponent={<View style={styles.header}>{header}
        {chats.length > 1 ? chats.map((value) => <Action key={value.id} label={`${value.title || 'Conversation'} · ${statusLabel(value.status)}${chat?.id === value.id ? ' · Selected' : ''}`}
          onPress={() => setSelected(value.id)} />) : null}
        <Body>{chat?.agent ?? item.agent} · Model: {chat?.model ?? 'Default'} · Effort: {chat?.effort ?? 'Default'} · {chat?.planMode ? 'Plan mode' : 'Normal mode'}</Body>
        <Body>{statusLabel(chat?.status)}{chat?.phase === 'restoring' ? ' · Restoring session' : ''}</Body>
        <StateNotice resource={state} offline={offline} refresh={state.refresh} refreshLabel="Refresh transcript" />
        <Action label="Jump to latest" onPress={() => { following.current = true; ref.current?.scrollToEnd({ animated: false }); }} />
        {state.data?.trimmed ? <><Body>History is limited to a bounded reading window.</Body>
          <Action label="Load latest messages" disabled={offline || state.refreshing} onPress={() => { void workflow.latest(chat?.id ?? ''); }} /></> : null}
        {state.data?.gap ? <Body>Some events are missing. Refresh to reconcile history.</Body> : null}
        {state.data?.hasOlder ? <Action label="Load older messages" disabled={offline || state.refreshing} onPress={() => { following.current = false; workflow.updateLocal(chat?.id ?? '', { following: false }); void workflow.older(chat?.id ?? ''); }} /> : null}
      </View>}
      ListEmptyComponent={state.status === 'ready' ? <Body>No messages yet.</Body> : undefined}
      renderItem={({ item: row }) => row.kind === 'event' ? <TranscriptCard row={row.row} />
        : <View><WorkbenchLink item={row.item} />{row.item.pullRequestId ? <ShellLink href={pullRequestRoute(row.item.pullRequestId)} label={`Pull request for ${workbenchTitle(row.item)}`} /> : null}</View>} />
    {chat ? <Composer item={item} chatId={chat.id} current={!stale && !state.stale && state.status === 'ready'} /> : <Body>No conversation is available for this item.</Body>}
  </View>;
}
export function WorkbenchDetailScreen({ kind }: { kind: 'session' | 'thread' }) {
  const params = useLocalSearchParams();
  const id = typeof params.id === 'string' ? params.id : '';
  const state = useResource<Workbench>('workbench', id, Boolean(id), true);
  const valid = Boolean(state.data && workbenchKind(state.data) === kind);
  const children = useResource<Workbench[]>('children', id, valid && kind === 'thread');
  const readiness = useResource<WorkbenchReadiness>('readiness', '', valid);
  const colors = useShellColors(); const offline = useNetwork() === 'offline';
  const item = valid ? state.data : undefined;
  useEffect(() => { if (item) completeIntent(`/${kind === 'session' ? 'sessions' : 'threads'}/${encodeURIComponent(id)}`); }, [item, kind, id]);
  const header = <View style={styles.header}><Heading>{item ? workbenchTitle(item) : kind === 'session' ? 'Session' : 'Thread'}</Heading>
    <StateNotice resource={state} offline={offline} refresh={state.refresh} />
    {state.data && !valid ? <Body>This link has the wrong work type. Return to its list.</Body> : null}
    {item ? <><Body>{workbenchSummary(item)}</Body>
      {item.statusMessage ? <NativeText text={item.statusMessage} /> : null}
      <Body>Readiness: {readiness.data && readiness.status === 'ready' && !readiness.stale ? readiness.data.sandbox.agents[item.agent]?.ok ? 'Available' : 'Unavailable' : 'Unknown'}</Body>
      {readiness.data?.sandbox.reasons.map((reason, index) => <Body key={`${reason.code}:${index}`}>{reason.message}</Body>)}
      {item.threadId ? <ShellLink href={threadRoute(item.threadId)} label="Open parent thread" /> : null}
      {item.pullRequestId ? <ShellLink href={pullRequestRoute(item.pullRequestId)} label="Open related pull request" /> : null}
      {kind === 'thread' ? <><Body>Child sessions</Body><StateNotice resource={children} offline={offline} refresh={children.refresh} refreshLabel="Refresh child sessions" />
        {children.status === 'ready' && !children.data?.length ? <Body>No child sessions yet.</Body> : null}</> : null}
    </> : <><WorkspaceLink /><ShellLink href={kind === 'session' ? '/sessions' : '/threads'} label="Return to list" /></>}
  </View>;
  return <SafeAreaView edges={['left', 'right', 'bottom']} style={[styles.page, { backgroundColor: colors.background }]}>
    <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? 96 : 0}>
      {item ? <Conversation key={item.id} item={item} stale={state.stale || state.status !== 'ready'} header={header} childrenItems={kind === 'thread' ? children.data ?? [] : []} />
        : <ScrollView contentContainerStyle={styles.content}>{header}</ScrollView>}
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

type PrDetail = Awaited<ReturnType<typeof pullRequests.get>>;
export function PullRequestDetailScreen() {
  const params = useLocalSearchParams(); const id = typeof params.id === 'string' ? params.id : '';
  const state = useResource<PrDetail>('pr', id, Boolean(id), true);
  const timeline = useResource<{ events: MergeQueueTimelineEvent[] }>('timeline', id, Boolean(state.data));
  const colors = useShellColors(); const offline = useNetwork() === 'offline';
  const row = state.data?.row;
  useEffect(() => { if (row) completeIntent(`/attention/${encodeURIComponent(id)}`); }, [row, id]);
  const summary = state.data?.fresh ?? row?.summary;
  return <SafeAreaView edges={['left', 'right', 'bottom']} style={[styles.page, { backgroundColor: colors.background }]}>
    <FlatList data={row ? timeline.data?.events ?? [] : []} keyExtractor={(event, index) => `${event.at}:${event.trigger}:${index}`}
      accessibilityRole="list" accessibilityLabel="Pull request and merge queue timeline" initialNumToRender={12} maxToRenderPerBatch={10} windowSize={7} contentContainerStyle={styles.content}
      refreshing={state.refreshing || timeline.refreshing} onRefresh={() => { void state.refresh(); void timeline.refresh(); }}
      ListHeaderComponent={<View style={styles.header}><Heading>{summary?.title || 'Pull request'}</Heading>
        <StateNotice resource={state} offline={offline} refresh={state.refresh} />
        {row && summary ? <><Body>{row.owner}/{row.repo} #{row.number} · {statusLabel(row.state)}</Body><Body>Author: {summary.author || 'Unknown'}</Body>
          {!state.data?.fresh ? <Body>Provider detail is unavailable. The server snapshot is shown.</Body> : null}
          <Body>Review: {reviewLabel(summary.effectiveReviewDecision ?? summary.reviewDecision)}</Body>
          <Body>CI: {ciLabel(summary.ciStatus)}</Body><Body>Mergeability: {mergeabilityLabel(summary.mergeable)}</Body>
          <Body>Merge state: {mergeStateLabel(summary.mergeStateStatus)}</Body>
          <Body>Updated: {dateLabel(summary.updatedAt ?? row.updatedAt)}</Body>
          <Body>Stack: {stackLabel(row)}</Body>
          <Body>Queue: {row.mergeQueued ? queueLabel(row.mergeQueue?.status) : row.mergeQueue === undefined ? 'Unknown' : 'Not queued'}</Body>
          {row.mergeQueue ? <><Body>Queue position: {row.mergeQueue.position}</Body>
            <Body>External queue: {externalLabel(row.mergeQueue.external?.state)}</Body>
            {row.mergeQueue.reason ? <NativeText text={row.mergeQueue.reason} /> : null}</> : null}
          {summary.humanGates?.length ? summary.humanGates.map((gate, index) => <Body key={index}>Human gate: {gate.name}</Body>) : <Body>Human gates: {summary.humanGates ? 'None reported' : 'Unknown'}</Body>}
          {row.autoMergeState?.needsHuman ? <Body>{row.autoMergeState.needsHuman.reason}</Body> : null}
          {row.session ? <ShellLink href={sessionRoute(row.session.id)} label={`Session: ${row.session.name}`} /> : null}
          {safeExternalUrl(summary.url) ? <Action label="Open pull request website" onPress={() => openExternal(summary.url)} /> : null}
          <Body>Merge queue timeline · Read only</Body><StateNotice resource={timeline} offline={offline} refresh={timeline.refresh} refreshLabel="Refresh queue timeline" />
          {timeline.status === 'ready' && !timeline.data?.events.length ? <Body>No merge queue events.</Body> : null}
        </> : <ShellLink href="/attention" label="Return to Attention" />}
      </View>}
      renderItem={({ item }) => <View style={[styles.transcript, { backgroundColor: colors.card }]}><Body>{dateLabel(item.at)} · {queueLabel(item.toStatus)}</Body><NativeText text={item.message} /></View>} />
  </SafeAreaView>;
}
