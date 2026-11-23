import { subagentCardModel, type SubagentTab } from '@talyn/shared';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { radius, type, useTheme } from '../../theme/tokens';
import { StatusDot } from './Pulse';

/** Tabs above the conversation: the main transcript, then one per subagent. Like web. */
export function SubagentTabBar({ tabs, current, onSelect }: {
  tabs: SubagentTab[]; current: SubagentTab | null; onSelect(toolId: string | null): void;
}) {
  const c = useTheme();
  const tab = (key: string, selected: boolean, label: string, onPress: () => void, children: ReactNode) =>
    <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected }} accessibilityLabel={label} onPress={onPress} hitSlop={4}
      style={[styles.tab, selected && { backgroundColor: c.surface }]}>{children}</Pressable>;
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" testID="subagent-tabs"
    style={[styles.bar, { borderColor: c.border }]} contentContainerStyle={styles.content}>
    {tab('main', !current, 'Main transcript', () => onSelect(null),
      <Text style={[type.caption, { color: !current ? c.text : c.muted }]}>Main</Text>)}
    {tabs.map((item) => {
      const model = subagentCardModel(item.block, true)!;
      const title = model.title || model.type;
      const selected = current?.toolId === item.toolId;
      return tab(item.toolId, selected, `Subagent ${title}${model.running ? ', running' : model.failed ? ', failed' : ''}`, () => onSelect(item.toolId), <>
        <StatusDot state={model.running ? 'running' : model.failed ? 'error' : 'done'} />
        <Text numberOfLines={1} style={[type.caption, styles.title, { color: selected ? c.text : c.muted }]}>{title}</Text>
      </>);
    })}
  </ScrollView>;
}

const styles = StyleSheet.create({
  bar: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth },
  content: { gap: 4, paddingHorizontal: 8, paddingVertical: 6 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.md },
  title: { maxWidth: 180 },
});
