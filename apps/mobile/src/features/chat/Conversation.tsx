import type { ToolBlock, Workbench } from '@talyn/shared';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View, type TextInput } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { AppText } from '../../components/UI';
import { StateNotice, workflowStyles as styles } from '../../components/Workflow';
import { useNow } from '../../lib/time';
import { type, useTheme } from '../../theme/tokens';
import { useLocal, useResource } from '../../workflow/hooks';
import type { Transcript } from '../../workflow/model';
import { isStarting, StartingHint, StartingLine } from '../sessions/Starting';
import { chatActions } from './actions';
import { Composer } from './Composer';
import { fullToolFrom, TranscriptContext, toolSeq, type TranscriptActions } from './fullTool';
import { TypingDots } from './Pulse';
import { RowBoundary } from './RowBoundary';
import { TranscriptRowCache, type TranscriptRow as Row } from './transcript';
import { TranscriptRow, type PlanControls } from './TranscriptRow';

/** How close to the newest message still counts as following new output. */
const FOLLOW_DISTANCE = 64;
/** How close to the oldest loaded message the next older page loads, in screen heights. */
const OLDER_DISTANCE = 0.6;

/**
 * The conversation for a session or a thread. The list is inverted: index 0 is
 * the newest message, so it opens at the newest message with no scroll after
 * layout. Older history loads by itself when the reader reaches the top.
 */
export function Conversation({ item, ready, header, top }: {
  item: Workbench; ready: boolean; header?: ReactNode;
  /** Content above the oldest message. Receives a callback that stops following new output while the reader expands it. */
  top?: (pauseFollowing: () => void) => ReactNode;
}) {
  const { workflow } = useMobileRuntime();
  const c = useTheme();
  const now = useNow();
  // Like web and desktop: a session shows its newest chat. Older sessions can have more than one.
  const chats = item.chats ?? [];
  const chat = chats[chats.length - 1];
  const state = useResource<Transcript>('transcript', chat?.id ?? '', Boolean(chat));
  const offline = useNetwork() === 'offline';
  const local = useLocal(chat?.id ?? '');
  const ref = useRef<FlatList<Row>>(null);
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const [following, setFollowing] = useState(local.following);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
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
  const actions: TranscriptActions = useMemo(() => ({
    loadFullTool: async (tool: ToolBlock) => {
      const seq = toolSeq(tool);
      if (!chat || seq === null) return null;
      return fullToolFrom(tool, await workflow.fullEvents(chat.id, seq));
    },
  }), [workflow, chat]);
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
  const empty = state.status === 'ready' && rows.length === 0;
  const starting = isStarting(item);
  // A new sandbox: show what it does in place of the empty conversation, also while the first load runs.
  const startHint = starting && rows.length === 0 && (state.status === 'idle' || state.status === 'loading' || state.status === 'ready');

  return <View style={{ flex: 1 }}>
    {header}
    <View style={{ flex: 1 }}>
      <RowBoundary label="The conversation" resetKey={chat?.id} retry><TranscriptContext.Provider value={actions}>
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
        onEndReached={loadOlder} onEndReachedThreshold={OLDER_DISTANCE}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive"
        ListHeaderComponent={starting && !running && rows.length ? <StartingLine workbench={item} /> : running ? <View accessibilityLiveRegion="polite" style={local_.working}>
          <TypingDots />
          <Text style={[type.caption, { color: c.muted }]}>{chat?.phase === 'restoring' ? 'Restoring the sandbox. This can take a few minutes.' : 'Working'}</Text>
        </View> : undefined}
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
        renderItem={({ item: row }) => <TranscriptRow row={row} now={now} workbench={item} plan={plan} />} />
      </TranscriptContext.Provider></RowBoundary>
      {startHint ? <View pointerEvents="box-none" style={local_.startHint}>
        <StartingHint workbench={item} queued={chat?.queuedMessages.length ?? 0} canWrite={Boolean(chat)} />
      </View> : null}
      {!following && rows.length ? <Pressable accessibilityRole="button" accessibilityLabel="Jump to latest" onPress={jumpToLatest} hitSlop={6}
        style={[local_.jump, { backgroundColor: c.elevated, borderColor: c.border }]}>
        <SymbolView name={{ ios: 'arrow.down', android: 'arrow_downward' }} size={16} tintColor={c.text} />
      </Pressable> : null}
    </View>
    {chat ? <Composer item={item} chatId={chat.id} ready={ready} inputRef={inputRef} />
      : startHint ? null : <AppText variant="meta" tone="muted" style={local_.empty}>No conversation is available for this item.</AppText>}
  </View>;
}

const local_ = StyleSheet.create({
  content: { paddingTop: 8, paddingBottom: 12 },
  working: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  top: { gap: 8, paddingBottom: 8 },
  older: { height: 28, alignItems: 'center', justifyContent: 'center' },
  note: { textAlign: 'center' },
  empty: { paddingVertical: 32, textAlign: 'center' },
  startHint: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  jump: { position: 'absolute', right: 16, bottom: 12, width: 40, height: 40, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center', justifyContent: 'center', elevation: 2, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
});
