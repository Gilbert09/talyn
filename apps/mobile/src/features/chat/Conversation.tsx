import { nextRunningSubagentTab, runningSubagentCount, subagentTabs, type ToolBlock, type Workbench } from '@talyn/shared';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View, type TextInput } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { AppText } from '../../components/UI';
import { StateNotice, workflowStyles as styles } from '../../components/Workflow';
import { useFeatures } from '../../lib/features';
import { useNow } from '../../lib/time';
import { radius, type, useTheme, withAlpha } from '../../theme/tokens';
import { useLocal, useResource } from '../../workflow/hooks';
import { alternateChatAgent, type Transcript } from '../../workflow/model';
import { slimTools } from '../../workflow/slim';
import { FleetReconnectNotice } from '../agents/FleetReconnectNotice';
import { TurnFailureActions } from './TurnFailureActions';
import { isStarting, StartingHint, StartingLine } from '../sessions/Starting';
import { chatActions } from './actions';
import { Composer } from './Composer';
import { FindBar } from './FindBar';
import { MessageMenuContext, useMessageMenu } from './messageMenu';
import { fullToolFrom, TranscriptContext, toolSeq, type TranscriptActions } from './fullTool';
import { StatusDot, TypingDots } from './Pulse';
import { RowBoundary } from './RowBoundary';
import { TranscriptRowCache, type TranscriptRow as Row } from './transcript';
import { findMatches, matchCountLabel, normalizeQuery, selectedIndex, stepIndex, type FindMatch, type FindSelection } from './transcriptFind';
import { TranscriptRow, type PlanControls, type QuestionControls } from './TranscriptRow';
import { SubagentTabBar } from './SubagentTabs';
import { SubagentTabOpener, SubagentTranscript } from './ToolRow';

/** How close to the newest message still counts as following new output. */
const FOLLOW_DISTANCE = 64;
/** How close to the oldest loaded message the next older page loads, in screen heights. */
const OLDER_DISTANCE = 0.6;

/**
 * The conversation for a session or a thread. The list is inverted: index 0 is
 * the newest message, so it opens at the newest message with no scroll after
 * layout. Older history loads by itself when the reader reaches the top.
 */
export function Conversation({ item, ready, canSwitchAgent, header, top, bottom, find = 0, onCloseFind }: {
  item: Workbench; ready: boolean; canSwitchAgent: boolean; header?: ReactNode;
  /** Content below the newest message, while no turn runs. */
  bottom?: ReactNode;
  /** 0 hides the find bar. Each new value opens it and focuses its field. */
  find?: number; onCloseFind?(): void;
  /** Content above the oldest message. Receives a callback that stops following new output while the reader expands it. */
  top?: (pauseFollowing: () => void) => ReactNode;
}) {
  const { workflow } = useMobileRuntime();
  const c = useTheme();
  const now = useNow();
  // Like web and desktop: a session shows its newest chat. Older sessions can have more than one.
  const chats = item.chats ?? [];
  const chat = chats[chats.length - 1];
  const alternate = canSwitchAgent ? alternateChatAgent(item, chat) : undefined;
  const state = useResource<Transcript>('transcript', chat?.id ?? '', Boolean(chat));
  const offline = useNetwork() === 'offline';
  const local = useLocal(chat?.id ?? '');
  const ref = useRef<FlatList<Row>>(null);
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const [following, setFollowing] = useState(local.following);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  const [questionBusy, setQuestionBusy] = useState(false);
  const subagents = useFeatures()?.sessionSubagents === true;
  const runningAgents = useMemo(() => subagents && chat?.status === 'running'
    ? runningSubagentCount((state.data?.events ?? []).filter((entry) => entry.turn === state.data?.events.at(-1)?.turn).map((entry) => entry.event)) : 0,
  [subagents, chat?.status, state.data]);
  // The subagent tab shown, by Agent call id. Null shows the conversation. Another chat starts on the conversation.
  const [subagentTab, setSubagentTab] = useState<{ chatId: string; toolId: string } | null>(null);
  const selectedTab = subagentTab && subagentTab.chatId === chat?.id ? subagentTab.toolId : null;
  const tabs = useMemo(() => subagents ? subagentTabs(state.data?.events ?? [], selectedTab) : [], [subagents, state.data, selectedTab]);
  const currentTab = tabs.find((tab) => tab.toolId === selectedTab) ?? null;
  const openTab = useCallback((toolId: string | null) => setSubagentTab(toolId && chat ? { chatId: chat.id, toolId } : null), [chat]);
  const messageMenu = useMessageMenu(item);
  const cache = useRef(new TranscriptRowCache());
  /** The reader reached the oldest loaded message while another load ran. The older page is owed once it ends. */
  const olderOwed = useRef(false);
  useLayoutEffect(() => { setFollowing(workflow.local(chat?.id ?? '').following); }, [workflow, chat?.id]);
  useEffect(() => { if (chat) workflow.updateLocal(`selected:${item.id}`, { selectedChat: chat.id }); }, [workflow, item.id, chat?.id]);
  const rows = useMemo(() => {
    const list = cache.current.rows(chat?.id ?? '', state.data?.events ?? []);
    for (const message of chat?.queuedMessages ?? []) {
      list.push({ key: `queue:${message.id}`, kind: 'queued', text: message.text, fromTalyn: message.origin === 'talyn', timestamp: message.queuedAt });
    }
    return list.reverse();
  }, [chat?.id, chat?.queuedMessages, state.data]);

  const pauseFollowing = useCallback(() => { setFollowing(false); workflow.updateLocal(chat?.id ?? item.id, { following: false }); }, [workflow, chat?.id, item.id]);
  const data = state.data;
  const canLoadOlder = Boolean(chat && data?.hasOlder && !data.limited && !data.olderFailed && !loadingOlder && !state.refreshing && !offline);
  const chatId = chat?.id;
  const startOlder = useCallback(() => {
    if (!chatId) return;
    setLoadingOlder(true);
    void workflow.older(chatId).finally(() => setLoadingOlder(false));
  }, [workflow, chatId]);
  const loadOlder = () => {
    if (canLoadOlder) { olderOwed.current = false; startOlder(); }
    else if (data?.hasOlder && !data.limited && !data.olderFailed) olderOwed.current = true;
  };
  // The list asks once per content size. When it asked during another load, ask for it when that load ends.
  useEffect(() => {
    if (olderOwed.current && canLoadOlder) { olderOwed.current = false; startOlder(); }
  }, [canLoadOlder, startOlder]);
  const jumpToLatest = () => {
    setFollowing(true); workflow.updateLocal(chat?.id ?? item.id, { following: true });
    ref.current?.scrollToOffset({ offset: 0, animated: true });
  };
  const partialTools = useMemo(() => new Set((state.data?.events ?? []).flatMap((entry) => slimTools(entry.event))), [state.data]);
  const actions: TranscriptActions = useMemo(() => ({
    partialTools,
    loadFullTool: async (tool: ToolBlock) => {
      const seq = toolSeq(tool);
      if (!chat || seq === null) return null;
      return fullToolFrom(tool, await workflow.fullEvents(chat.id, seq));
    },
  }), [workflow, chat, partialTools]);
  const running = chat?.status === 'running';
  const plan: PlanControls = useMemo(() => ({
    busy: planBusy, disabled: running || offline || !ready,
    approve: () => {
      if (!chat || planBusy) return;
      setPlanBusy(true);
      chatActions.approvePlan(chat.id).then(() => {
        void workflow.load('workbench', item.id); void workflow.load('transcript', chat.id);
      }, () => Alert.alert('Could not start the build', 'Try again.')).finally(() => setPlanBusy(false));
    },
    keepPlanning: () => {
      if (chat && !chat.planMode) {
        chatActions.setPlanMode(chat.id, true).then(() => { void workflow.load('workbench', item.id); },
          () => Alert.alert('Could not turn plan mode on', 'Try again.'));
      }
      inputRef.current?.focus();
    },
  }), [planBusy, running, offline, ready, chat, workflow, item.id]);
  const queued = Boolean(chat?.queuedMessages?.length);
  const question: QuestionControls = useMemo(() => ({
    busy: questionBusy, disabled: offline || !ready, waiting: running || queued,
    answer: (text: string) => {
      if (!chat || questionBusy) return;
      setQuestionBusy(true);
      chatActions.answerQuestion(chat.id, text).then(() => {
        void workflow.load('workbench', item.id); void workflow.load('transcript', chat.id);
      }, () => Alert.alert('Could not send the answer', 'Try again.')).finally(() => setQuestionBusy(false));
    },
  }), [questionBusy, running, queued, offline, ready, chat, workflow, item.id]);

  // Find in the loaded conversation. Matches are oldest first, and a new query selects the newest.
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<FindSelection | null>(null);
  const [jump, setJump] = useState(0);
  const jumped = useRef(0);
  const scrollRetries = useRef(0);
  const findOpen = find > 0;
  const oldestFirst = useMemo(() => findOpen ? rows.slice().reverse() : [], [findOpen, rows]);
  const matches = useMemo(() => findMatches(oldestFirst, query), [oldestFirst, query]);
  const current = selectedIndex(matches, selected);
  const currentKey = current >= 0 ? matches[current].rowKey : null;
  const highlight = findOpen ? normalizeQuery(query) : '';
  const matchKeys = useMemo(() => new Set(matches.map((match) => match.rowKey)), [matches]);
  const select = (match: FindMatch | undefined) => {
    setSelected(match ? { rowKey: match.rowKey, occurrence: match.occurrence } : null);
    setJump((value) => value + 1);
  };
  const changeQuery = (text: string) => { setQuery(text); select(findMatches(oldestFirst, text).at(-1)); };
  const step = (direction: 1 | -1) => { if (matches.length) select(matches[stepIndex(current, matches.length, direction)]); };
  const closeFind = () => { setQuery(''); setSelected(null); onCloseFind?.(); };
  useEffect(() => {
    if (jump === jumped.current) return;
    jumped.current = jump;
    if (!currentKey) return;
    const index = rows.findIndex((row) => row.key === currentKey);
    if (index < 0) return;
    scrollRetries.current = 0;
    ref.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
  }, [jump, currentKey, rows]);
  const extraData = useMemo(() => ({ highlight, matchKeys, currentKey }), [highlight, matchKeys, currentKey]);
  const currentStyle = { backgroundColor: withAlpha(c.primary, c.mode === 'dark' ? 0.14 : 0.08) };

  const empty = state.status === 'ready' && rows.length === 0;
  const starting = isStarting(item);
  // A new sandbox: show what it does in place of the empty conversation, also while the first load runs.
  const startHint = starting && rows.length === 0 && (state.status === 'idle' || state.status === 'loading' || state.status === 'ready');

  return <MessageMenuContext.Provider value={messageMenu.open}><View style={{ flex: 1 }}>
    {header}
    <FleetReconnectNotice />
    {findOpen ? <FindBar query={query} onChangeQuery={changeQuery} count={matches.length} label={matchCountLabel(current, matches.length, query)}
      partial={Boolean(data?.hasOlder)} focusKey={find} onPrevious={() => step(-1)} onNext={() => step(1)} onClose={closeFind} /> : null}
    {tabs.length ? <SubagentTabBar tabs={tabs} current={currentTab} onSelect={openTab} /> : null}
    {currentTab ? <View style={{ flex: 1 }}>
      <RowBoundary label="The subagent" resetKey={currentTab.toolId} retry><TranscriptContext.Provider value={actions}>
        <SubagentTranscript tool={currentTab.block} />
      </TranscriptContext.Provider></RowBoundary>
    </View> : <View style={{ flex: 1 }}>
      <RowBoundary label="The conversation" resetKey={chat?.id} retry><TranscriptContext.Provider value={actions}><SubagentTabOpener.Provider value={openTab}>
      <FlatList ref={ref} key={chat?.id ?? item.id} inverted data={rows} keyExtractor={(row) => row.key} accessibilityRole="list" accessibilityLabel="Conversation transcript"
        initialNumToRender={14} maxToRenderPerBatch={10} windowSize={9} contentContainerStyle={[styles.content, local_.content]}
        contentOffset={{ x: 0, y: local.offset }} scrollEventThrottle={100}
        maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: FOLLOW_DISTANCE }}
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          const offset = contentOffset.y;
          const next = offset < FOLLOW_DISTANCE;
          if (contentSize.height - offset - layoutMeasurement.height > layoutMeasurement.height * OLDER_DISTANCE * 2) olderOwed.current = false;
          if (next !== following) setFollowing(next);
          workflow.updateLocal(chat?.id ?? item.id, { offset, following: next });
          // Back at the newest message: older events past the release bound load again on the next scroll up.
          if (next && !following && chat) workflow.release(chat.id);
        }}
        onEndReached={loadOlder} onEndReachedThreshold={OLDER_DISTANCE} extraData={extraData}
        onScrollToIndexFailed={(info) => {
          // The row is not measured yet. Go near it by the average row height, then try again.
          ref.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
          if (scrollRetries.current++ < 3) setTimeout(() => ref.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.5 }), 120);
        }}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive"
        ListHeaderComponent={starting && !running && rows.length ? <StartingLine workbench={item} /> : running ? <View accessibilityLiveRegion="polite" style={local_.working}>
          <TypingDots />
          <Text style={[type.caption, { color: c.muted }]}>{chat?.phase === 'restoring' ? 'Restoring the sandbox. This can take a few minutes.' : 'Working'}</Text>
        </View> : bottom ? <View>{bottom}</View> : undefined}
        ListFooterComponent={<View style={local_.top}>
          {top ? <View>{top(pauseFollowing)}</View> : null}
          {startHint ? null : <StateNotice resource={state} offline={offline} refresh={state.refresh} refreshLabel="Try again" />}
          {loadingOlder ? <View style={local_.older}><ActivityIndicator accessibilityLabel="Loading earlier messages" size="small" color={c.muted} /></View> : null}
          {data?.olderFailed ? <View style={local_.older}>
            <Pressable accessibilityRole="button" accessibilityLabel="Could not load earlier messages. Try again" hitSlop={8}
              onPress={() => { if (chatId) { setLoadingOlder(true); void workflow.retryOlder(chatId).finally(() => setLoadingOlder(false)); } }}>
              <AppText variant="caption" tone="muted">Could not load earlier messages. <AppText variant="caption" style={{ color: c.primaryAction }}>Try again</AppText></AppText>
            </Pressable>
          </View> : null}
          {data?.limited && data.hasOlder ? <AppText variant="caption" tone="muted" style={local_.note}>History is limited on this device. Jump to the newest message to read further back.</AppText> : null}
          {state.data?.gap ? <AppText variant="caption" tone="muted" style={local_.note}>Some events are missing. Talyn is loading them again.</AppText> : null}
          {empty && !startHint ? <AppText variant="meta" tone="muted" style={local_.empty}>No messages yet.</AppText> : null}
        </View>}
        renderItem={({ item: row }) => <View style={row.key === currentKey ? [local_.current, currentStyle] : undefined}>
          <TranscriptRow row={row} now={now} workbench={item} plan={plan} question={question} highlight={highlight && matchKeys.has(row.key) ? highlight : undefined} />
          {row.kind === 'failed' && rows[0]?.key === row.key && chat && (chat.status === 'idle' || chat.status === 'error')
            && !chat.queuedMessages?.length ? <TurnFailureActions chatId={chat.id} workbenchId={item.id} text={row.text}
              reconnect={row.reason === 'reauth'} limited={row.reason === 'limited'} alternateAgent={alternate}
              resumeAt={chat.resumeAt} resumeReason={chat.resumeReason} disabled={offline || !ready} /> : null}
        </View>} />
      </SubagentTabOpener.Provider></TranscriptContext.Provider></RowBoundary>
      {startHint ? <View pointerEvents="box-none" style={local_.startHint}>
        <StartingHint workbench={item} queued={chat?.queuedMessages.length ?? 0} canWrite={Boolean(chat)} />
      </View> : null}
      {!following && rows.length ? <Pressable accessibilityRole="button" accessibilityLabel="Jump to latest" onPress={jumpToLatest} hitSlop={6}
        style={[local_.jump, { backgroundColor: c.elevated, borderColor: c.border }]}>
        <SymbolView name={{ ios: 'arrow.down', android: 'arrow_downward' }} size={16} tintColor={c.text} />
      </Pressable> : null}
    </View>}
    {runningAgents > 0 ? <Pressable accessibilityRole="button" testID="subagent-chip" hitSlop={6}
      accessibilityLabel={`${runningAgents} ${runningAgents === 1 ? 'subagent' : 'subagents'} running. Open a subagent's tab`}
      // Each tap opens the next running subagent, so repeated taps go through all of them.
      onPress={() => { const next = nextRunningSubagentTab(tabs, selectedTab); if (next) openTab(next); }}
      style={[local_.chip, { borderColor: c.border, backgroundColor: c.surface }]}>
      <StatusDot state="running" />
      <AppText variant="caption" tone="muted">{runningAgents} {runningAgents === 1 ? 'subagent' : 'subagents'} running</AppText>
    </Pressable> : null}
    {chat ? <Composer item={item} chatId={chat.id} ready={ready} inputRef={inputRef} />
      : startHint ? null : <AppText variant="meta" tone="muted" style={local_.empty}>No conversation is available for this item.</AppText>}
    {messageMenu.elements}
  </View></MessageMenuContext.Provider>;
}

const local_ = StyleSheet.create({
  content: { paddingTop: 8, paddingBottom: 12 },
  current: { borderRadius: radius.md, marginHorizontal: -6, paddingHorizontal: 6 },
  working: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, marginBottom: 6, paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
  top: { gap: 8, paddingBottom: 8 },
  older: { height: 28, alignItems: 'center', justifyContent: 'center' },
  note: { textAlign: 'center' },
  empty: { paddingVertical: 32, textAlign: 'center' },
  startHint: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  jump: { position: 'absolute', right: 16, bottom: 12, width: 40, height: 40, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center', justifyContent: 'center', elevation: 2, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
});
