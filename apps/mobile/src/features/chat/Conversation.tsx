import type { Workbench } from '@talyn/shared';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { Disclosure, Pill } from '../../components/UI';
import { Action, Body, StateNotice, workflowStyles as styles } from '../../components/Workflow';
import { useNow } from '../../lib/time';
import { sans, type, useTheme } from '../../theme/tokens';
import { useLocal, useResource } from '../../workflow/hooks';
import { statusLabel, transcriptRows, type Transcript, type TranscriptRow as Row } from '../../workflow/model';
import { Composer } from './Composer';
import { TranscriptRow } from './TranscriptRow';

type DetailRow = { row: Row; key: string };
/** How close to the newest message still counts as following new output. */
const FOLLOW_DISTANCE = 64;

/**
 * The conversation is an inverted list: index 0 is the newest message, so it
 * opens at the newest message with no scroll after layout. Older history loads
 * when the reader reaches the top.
 */
export function Conversation({ item, ready, header, top }: {
  item: Workbench; ready: boolean; header?: ReactNode;
  /** Content above the oldest message. Receives a callback that stops following new output while the reader expands it. */
  top?: (pauseFollowing: () => void) => ReactNode;
}) {
  const { workflow } = useMobileRuntime();
  const colors = useTheme();
  const now = useNow();
  const [selected, setSelected] = useState<string | null>(() => workflow.local(`selected:${item.id}`).selectedChat);
  const chats = item.chats ?? [];
  const chat = chats.find((value) => value.id === selected) ?? chats[0];
  const state = useResource<Transcript>('transcript', chat?.id ?? '', Boolean(chat));
  const offline = useNetwork() === 'offline';
  const local = useLocal(chat?.id ?? '');
  const ref = useRef<FlatList<DetailRow>>(null);
  const [following, setFollowing] = useState(local.following);
  useLayoutEffect(() => { setFollowing(workflow.local(chat?.id ?? '').following); }, [workflow, chat?.id]);
  const rows = useMemo(() => transcriptRows(chat?.id ?? '', state.data?.events ?? []), [chat?.id, state.data]);
  useEffect(() => { if (chat) workflow.updateLocal(`selected:${item.id}`, { selectedChat: chat.id }); }, [workflow, item.id, chat?.id]);
  const detailRows: DetailRow[] = useMemo(() => [...rows.map((row) => ({ row, key: row.key })),
    ...(chat?.queuedMessages ?? []).map((message) => ({ key: `queue:${message.id}`,
      row: { key: `queue:${message.id}`, author: message.origin === 'talyn' ? 'System' as const : 'You' as const,
        timestamp: message.queuedAt, text: `Queued on server\n${message.text}`, streaming: false } }))].reverse(), [rows, chat?.queuedMessages]);
  const pauseFollowing = () => { setFollowing(false); workflow.updateLocal(chat?.id ?? item.id, { following: false }); };
  const loadOlder = () => {
    if (!chat || !state.data?.hasOlder || state.refreshing || offline) return;
    void workflow.older(chat.id);
  };
  const jumpToLatest = () => {
    setFollowing(true); workflow.updateLocal(chat?.id ?? item.id, { following: true });
    ref.current?.scrollToOffset({ offset: 0, animated: true });
  };
  return <View style={{ flex: 1 }}>
    {header}
    {chats.length > 1 ? <ScrollView horizontal style={{ flexGrow: 0 }} contentContainerStyle={local_.chats} showsHorizontalScrollIndicator={false}>
      {chats.map((value) => {
        const active = chat?.id === value.id;
        return <Pressable key={value.id} accessibilityRole="button" onPress={() => setSelected(value.id)}
          accessibilityLabel={`${value.title || 'Conversation'} · ${statusLabel(value.status)}${active ? ' · Selected' : ''}`} accessibilityState={{ selected: active }}
          style={[local_.chip, { backgroundColor: active ? colors.surface : 'transparent', borderColor: colors.border }]}>
          <Text numberOfLines={1} style={[type.meta, sans(active ? 600 : 500), { color: active ? colors.text : colors.muted }]}>{value.title || 'Conversation'}</Text>
        </Pressable>;
      })}
    </ScrollView> : null}
    <View style={{ flex: 1 }}>
      <FlatList ref={ref} key={chat?.id ?? item.id} inverted data={detailRows} keyExtractor={(row) => row.key} accessibilityRole="list" accessibilityLabel="Conversation transcript"
        initialNumToRender={14} maxToRenderPerBatch={10} windowSize={9} contentContainerStyle={[styles.content, { paddingTop: 12 }]}
        contentOffset={{ x: 0, y: local.offset }} scrollEventThrottle={100}
        maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: FOLLOW_DISTANCE }}
        onScroll={(event) => {
          const offset = event.nativeEvent.contentOffset.y;
          const next = offset < FOLLOW_DISTANCE;
          if (next !== following) setFollowing(next);
          workflow.updateLocal(chat?.id ?? item.id, { offset, following: next });
        }}
        onEndReached={loadOlder} onEndReachedThreshold={0.5}
        keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive"
        ListFooterComponent={<View style={{ gap: 10, paddingBottom: 8 }}>
          {top ? <View>{top(pauseFollowing)}</View> : null}
          <Disclosure title="Conversation details" onToggle={pauseFollowing}>
            <Body muted>{chat?.agent ?? item.agent} · Model: {chat?.model ?? 'Default'} · Effort: {chat?.effort ?? 'Default'} · {chat?.planMode ? 'Plan mode' : 'Normal mode'}</Body>
          </Disclosure>
          {chat?.phase === 'restoring' ? <Pill label="Restoring session" tone="information" /> : null}
          <StateNotice resource={state} offline={offline} refresh={state.refresh} refreshLabel="Refresh transcript" />
          {state.data?.hasOlder && state.refreshing ? <ActivityIndicator accessibilityLabel="Loading older messages" color={colors.muted} /> : null}
          {state.data?.trimmed ? <><Body muted>History is limited to a bounded reading window.</Body>
            <Action label="Load latest messages" disabled={offline || state.refreshing} onPress={() => { if (chat) void workflow.latest(chat.id); }} /></> : null}
          {state.data?.gap ? <Body muted>Some events are missing. Pull to reconcile history.</Body> : null}
        </View>}
        ListEmptyComponent={state.status === 'ready' ? <View style={local_.empty}><Body muted>No messages yet.</Body></View> : undefined}
        renderItem={({ item: row }) => <TranscriptRow row={row.row} now={now} />} />
      {!following && detailRows.length ? <Pressable accessibilityRole="button" accessibilityLabel="Jump to latest" onPress={jumpToLatest}
        style={[local_.jump, { backgroundColor: colors.elevated, borderColor: colors.border }]}>
        <SymbolView name={{ ios: 'arrow.down', android: 'arrow_downward' }} size={16} tintColor={colors.text} />
      </Pressable> : null}
    </View>
    {chat ? <Composer item={item} chatId={chat.id} ready={ready} /> : <Body muted>No conversation is available for this item.</Body>}
  </View>;
}

const local_ = StyleSheet.create({
  chats: { gap: 6, paddingHorizontal: 16, paddingVertical: 8 },
  chip: { borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, minHeight: 32, justifyContent: 'center', maxWidth: 220 },
  empty: { paddingVertical: 32, alignItems: 'center' },
  jump: { position: 'absolute', right: 16, bottom: 12, width: 40, height: 40, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center', justifyContent: 'center' },
});
