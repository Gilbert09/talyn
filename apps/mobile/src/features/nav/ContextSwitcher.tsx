import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useWorkspace } from '../../auth/AuthProvider';
import { PickerSheet, type PickerSection } from '../../components/PickerSheet';
import { useWorkspaceName } from '../../components/ScreenHeader';
import { openExternal } from '../../components/Workflow';
import { display, type, useTheme } from '../../theme/tokens';
import { webUrl } from '../more/Page';
import { SpaceTile } from '../spaces/Avatars';
import type { ActiveContextState } from '../spaces/context';
import { switcherLabel, switcherSections } from '../spaces/switcher';

/**
 * The drawer header, like web's `WorkspaceSwitcher`: the active space (tile,
 * name and team) or the workspace. A tap opens a sheet with my workspaces and,
 * when Spaces is offered, every team's spaces.
 */
export function ContextSwitcher({ state }: { state: ActiveContextState }) {
  const c = useTheme();
  const workspace = useWorkspace();
  const name = useWorkspaceName();
  const [open, setOpen] = useState(false);
  const label = switcherLabel(state.context, name);
  const teamsFailed = state.teams.data === undefined && state.teams.status !== 'loading' && state.teams.status !== 'idle';
  const sections: PickerSection[] = switcherSections({ workspaces: workspace.choices, teams: state.teams.data, teamsFailed,
    offered: state.offered, context: state.context }).map((section) => ({
    key: section.key, title: section.title, note: section.note,
    items: section.choices.map((choice) => ({
      key: choice.key, label: choice.label, selected: choice.selected,
      icon: choice.space ? undefined : { ios: 'square.grid.2x2', android: 'grid_view' },
      leading: choice.space ? <View style={styles.tileBox}><SpaceTile name={choice.space.name} color={choice.space.color} image={choice.space.image} size={16} /></View> : undefined,
      accessibilityLabel: `${choice.space ? 'Space' : 'Workspace'}: ${choice.label}`,
      onPress: () => { void state.select(choice.target); },
    })),
  }));
  if (state.offered) sections.push({ key: 'manage', items: [{ key: 'manage', label: 'Manage teams on the web',
    icon: { ios: 'arrow.up.right.square', android: 'open_in_new' }, onPress: () => openExternal(webUrl('/settings/teams')) }] });

  const accessibilityLabel = state.active ? `Space: ${label.title}, ${label.subtitle}` : name ? `Workspace: ${name}` : 'Choose workspace';
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel}
      accessibilityHint={state.offered ? 'Opens the workspace and space chooser.' : 'Opens the workspace chooser.'}
      onPress={() => setOpen(true)} style={({ pressed }) => [styles.switcher, { backgroundColor: pressed ? c.surface : 'transparent' }]}>
      {state.active ? <View style={[styles.tileFrame, { backgroundColor: c.surface }]}>
        <SpaceTile name={state.active.space.name} color={state.active.space.color} image={state.active.space.image} size={14} />
      </View> : null}
      <View style={styles.text}>
        <Text numberOfLines={1} style={[styles.title, { color: c.text }]}>{label.title}</Text>
        {label.subtitle ? <Text numberOfLines={1} style={[type.caption, { color: c.muted }]}>{label.subtitle}</Text> : null}
      </View>
      <SymbolView name={{ ios: 'chevron.up.chevron.down', android: 'unfold_more' }} size={14} tintColor={c.muted} />
    </Pressable>
    <PickerSheet visible={open} title={state.offered ? 'Switch workspace or space' : 'Switch workspace'} onClose={() => setOpen(false)}
      sections={sections} />
  </>;
}

const styles = StyleSheet.create({
  switcher: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 6, borderRadius: 8 },
  tileFrame: { width: 26, height: 26, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  tileBox: { width: 18, alignItems: 'center' },
  text: { flexShrink: 1 },
  title: { fontSize: 18, lineHeight: 24, ...display(600) },
});
