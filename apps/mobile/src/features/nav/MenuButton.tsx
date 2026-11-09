import { useNavigation } from 'expo-router';
import { DrawerActions } from 'expo-router/react-navigation';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { radius, useTheme } from '../../theme/tokens';
import { useNeedsYouCount } from './data';

/** Opens the navigation drawer. A dot shows when a session or thread waits on the person. */
export function MenuButton() {
  const c = useTheme();
  const navigation = useNavigation();
  const count = useNeedsYouCount();
  const [pressed, setPressed] = useState(false);
  return <Pressable accessibilityRole="button" accessibilityLabel="Open menu"
    accessibilityHint={count ? `${count} ${count === 1 ? 'item needs' : 'items need'} you.` : undefined}
    hitSlop={4} onPress={() => navigation.dispatch(DrawerActions.openDrawer())}
    onPressIn={() => setPressed(true)} onPressOut={() => setPressed(false)}
    style={[styles.button, { backgroundColor: pressed ? c.surface : 'transparent' }]}>
    <SymbolView name={{ ios: 'line.3.horizontal', android: 'menu' }} size={22} tintColor={c.text} />
    {count ? <View testID="menu-attention-dot" style={[styles.dot, { backgroundColor: c.information, borderColor: c.background }]} /> : null}
  </Pressable>;
}

const styles = StyleSheet.create({
  button: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
  dot: { position: 'absolute', top: 7, right: 6, width: 10, height: 10, borderRadius: 5, borderWidth: 2 },
});
