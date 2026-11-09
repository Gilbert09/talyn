import { Link } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useWorkspace } from '../auth/AuthProvider';
import { sans, type, useTheme } from '../theme/tokens';
import { Heading } from './Workflow';

// The last name seen for each workspace id, so a reload never draws a blank name.
const knownNames = new Map<string, string>();

export function useWorkspaceName() {
  const workspace = useWorkspace();
  const selected = workspace.selected;
  const found = workspace.choices.find((choice) => choice.id === selected)?.name;
  if (selected && found) knownNames.set(selected, found);
  return found ?? (selected ? knownNames.get(selected) : undefined);
}

/** Workspace name with a chevron. Opens the workspace chooser. */
export function WorkspaceSwitcher() {
  const c = useTheme();
  const name = useWorkspaceName();
  const label = name ?? 'Choose workspace';
  return <Link href="/workspaces" asChild>
    <Pressable accessibilityRole="link" accessibilityLabel={name ? `Workspace: ${name}` : label} accessibilityHint="Opens the workspace chooser."
      hitSlop={8} style={styles.switcher}>
      <View style={styles.switcherRow}>
        <Text numberOfLines={1} style={[type.meta, sans(500), { color: c.muted, flexShrink: 1 }]}>{label}</Text>
        <SymbolView name={{ ios: 'chevron.down', android: 'expand_more' }} size={12} tintColor={c.muted} />
      </View>
    </Pressable>
  </Link>;
}

/** A list screen's compact title with the workspace switcher above it. */
export function ScreenHeader({ title, trailing, children }: { title: string; trailing?: ReactNode; children?: ReactNode }) {
  return <View style={styles.header}>
    <WorkspaceSwitcher />
    <View style={styles.titleRow}><View style={{ flex: 1 }}><Heading>{title}</Heading></View>{trailing}</View>
    {children}
  </View>;
}

const styles = StyleSheet.create({
  header: { gap: 4, paddingBottom: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  switcher: { alignSelf: 'flex-start', minHeight: 28, justifyContent: 'center' },
  switcherRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
