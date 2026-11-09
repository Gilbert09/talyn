import type { WorkbenchChat } from '@talyn/shared';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { sans, type, useTheme } from '../../theme/tokens';
import { statusLabel } from '../../workflow/model';
import { StatusDot } from './Pulse';

const dotState = (chat: WorkbenchChat) => chat.status === 'running' ? 'running' as const : chat.status === 'error' ? 'error' as const
  : chat.status === 'awaiting_input' ? 'waiting' as const : null;

/** Compact chat tabs, like web `ChatTabs`: the selected one is underlined, each with a status dot when it has news. */
export function ChatTabs({ chats, selected, onSelect }: { chats: WorkbenchChat[]; selected: string | undefined; onSelect(id: string): void }) {
  const c = useTheme();
  return <View style={[styles.wrap, { borderColor: c.border }]}>
    <ScrollView horizontal accessibilityRole="tablist" accessibilityLabel="Chats" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
      {chats.map((chat) => {
        const active = chat.id === selected;
        const dot = dotState(chat);
        const title = chat.title || 'Chat';
        return <Pressable key={chat.id} accessibilityRole="tab" onPress={() => onSelect(chat.id)}
          accessibilityLabel={`${title} · ${statusLabel(chat.status)}${active ? ' · Selected' : ''}`} accessibilityState={{ selected: active }}
          style={[styles.tab, { borderBottomColor: active ? c.primary : 'transparent' }]}>
          {dot ? <StatusDot state={dot} /> : null}
          <Text numberOfLines={1} style={[type.meta, sans(active ? 600 : 500), { color: active ? c.text : c.muted }]}>{title}</Text>
        </Pressable>;
      })}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  wrap: { borderBottomWidth: StyleSheet.hairlineWidth },
  tabs: { paddingHorizontal: 12, gap: 4 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 200, minHeight: 40, paddingHorizontal: 8, borderBottomWidth: 2 },
});
