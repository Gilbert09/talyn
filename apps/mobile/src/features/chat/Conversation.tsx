import type { Workbench } from '@talyn/shared';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View, type TextInput } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { AppText } from '../../components/UI';
import { StateNotice, workflowStyles as styles } from '../../components/Workflow';
import { chatDetailsLine } from '../../lib/models';
import { useNow } from '../../lib/time';
import { type, useTheme } from '../../theme/tokens';
import { useLocal, useResource } from '../../workflow/hooks';
import type { Transcript } from '../../workflow/model';
import { chatActions } from './actions';
import { ChatTabs } from './ChatTabs';
import { Composer } from './Composer';
import { TypingDots } from './Pulse';
import { transcriptRows, type TranscriptRow as Row } from './transcript';
import { TranscriptRow, type PlanControls } from './TranscriptRow';

/** How close to the newest message still counts as following new output. */
const FOLLOW_DISTANCE = 64;

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
  const [selected, setSelected] = useState<string | null>(() => workflow.local(`selected:${item.id}`).selectedChat);
  const chats = item.chats ?? [];
  const chat = chats.find((value) => value.id === selected) ?? chats[0];
  const state = useResource<Transcript>('transcript', chat?.id ?? '', Boolean(chat));
  const offline = useNetwork() === 'offline';
  const local = useLocal(chat?.id ?? '');
  const ref = useRef<FlatList<Row>>(null);
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const [following, setFollowing] = useState(local.following);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  useLayoutEffect(() => { setFollowing(workflow.local(chat?.id ?? '').following); }, [workflow, chat?.id]);
  useEffect(() => { if (chat) workflow.updateLocal(`selected:${item.id}`, { selectedChat: chat.id }); }, [workflow, item.id, chat?.id]);
  const rows = useMemo(() => {
    const list = transcriptRows(chat?.id ?? '', state.data?.events ?? []);
    for (const message of chat?.queuedMessages ?? []) {
      list.push({ key: `queue:${message.id}`, kind: 'queued', text: message.text, fromTalyn: message.origin === 'talyn', timestamp: message.queuedAt });
    }
    return list.reverse();
  }, [chat?.id, chat?.queuedMessages, state.data]);

  const pauseFollowing = useCallback(() => { setFollowing(false); workflow.updateLocal(chat?.id ?? item.id, { following: false }); }, [workflow, chat?.id, item.id]);
  const loadOlder = () => {
    if (!chat || !state.data?.hasOlder || loadingOlder || state.refreshing || offline) return;
    setLoadingOlder(true);
    void workflow.older(chat.id).finally(() => setLoadingOlder(false));
  };
  const jumpToLatest = () => {
    setFollowing(true); workflow.updateLocal(chat?.id ?? item.id, { following: true });
    // A long read upwards can drop the newest messages from the bounded window. Reload them.
    const data = state.data;
    if (chat && data?.trimmed && (data.events.at(-1)?.seq ?? 0) < data.cursor) void workflow.latest(chat.id);
    ref.current?.scrollToOffset({ offset: 0, animated: true });
  };
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
  const details = chatDetailsLine(chat, item.agent);

  return <View style={{ flex: 1 }}>
    {header}
    {chats.length > 1 ? <ChatTabs chats={chats} selected={chat?.id} onSelect={setSelected} /> : null}
    {details ? <AppText variant="caption" tone="muted" numberOfLines={1} style={local_.details}>{details}</AppText> : null}
    <View style={{ flex: 1 }}>
      <FlatList ref={ref} key={chat?.id ?? item.id} inverted data={rows} keyExtractor={(row) => row.key} accessibilityRole="list" accessibilityLabel="Conversation transcript"
        initialNumToRender={14} maxToRenderPerBatch={10} windowSize={9} contentContainerStyle={[styles.content, local_.content]}
        contentOffset={{ x: 0, y: local.offset }} scrollEventThrottle={100}
        maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: FOLLOW_DISTANCE }}
        onScroll={(event) => {
          const offset = event.nativeEvent.contentOffset.y;
          const next = offset < FOLLOW_DISTANCE;
          if (next !== following) setFollowing(next);
          workflow.updateLocal(chat?.id ?? item.id, { offset, following: next });
        }}
        onEndReached={loadOlder} onEndReachedThreshold={0.6}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive"
        ListHeaderComponent={running ? <View accessibilityLiveRegion="polite" style={local_.working}>
          <TypingDots />
          <Text style={[type.caption, { color: c.muted }]}>{chat?.phase === 'restoring' ? 'Restoring the sandbox. This can take a few minutes.' : 'Working'}</Text>
        </View> : undefined}
        ListFooterComponent={<View style={local_.top}>
          {top ? <View>{top(pauseFollowing)}</View> : null}
          <StateNotice resource={state} offline={offline} refresh={state.refresh} refreshLabel="Try again" />
          {loadingOlder ? <View style={local_.older}><ActivityIndicator accessibilityLabel="Loading earlier messages" size="small" color={c.muted} /></View> : null}
          {state.data?.trimmed ? <AppText variant="caption" tone="muted" style={local_.note}>History is limited on this device.</AppText> : null}
          {state.data?.gap ? <AppText variant="caption" tone="muted" style={local_.note}>Some events are missing. Talyn is loading them again.</AppText> : null}
          {empty ? <AppText variant="meta" tone="muted" style={local_.empty}>No messages yet.</AppText> : null}
        </View>}
        renderItem={({ item: row }) => <TranscriptRow row={row} now={now} workbench={item} plan={plan} />} />
      {!following && rows.length ? <Pressable accessibilityRole="button" accessibilityLabel="Jump to latest" onPress={jumpToLatest} hitSlop={6}
        style={[local_.jump, { backgroundColor: c.elevated, borderColor: c.border }]}>
        <SymbolView name={{ ios: 'arrow.down', android: 'arrow_downward' }} size={16} tintColor={c.text} />
      </Pressable> : null}
    </View>
    {chat ? <Composer item={item} chatId={chat.id} ready={ready} inputRef={inputRef} />
      : <AppText variant="meta" tone="muted" style={local_.empty}>No conversation is available for this item.</AppText>}
  </View>;
}

const local_ = StyleSheet.create({
  content: { paddingTop: 8, paddingBottom: 12 },
  details: { paddingHorizontal: 16, paddingVertical: 6 },
  working: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  top: { gap: 8, paddingBottom: 8 },
  older: { height: 28, alignItems: 'center', justifyContent: 'center' },
  note: { textAlign: 'center' },
  empty: { paddingVertical: 32, textAlign: 'center' },
  jump: { position: 'absolute', right: 16, bottom: 12, width: 40, height: 40, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center', justifyContent: 'center', elevation: 2, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
});
