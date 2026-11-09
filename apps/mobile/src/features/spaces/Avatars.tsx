import { Image, StyleSheet, Text, View } from 'react-native';

import { sans, useTheme } from '../../theme/tokens';
import { memberName, spaceInitials } from './model';

/** A space's square tile: its image, or its initials on its colour. Mirrors web `SpaceTile`. */
export function SpaceTile({ name, color, image, size = 16 }: { name: string; color: string | null; image?: string | null; size?: number }) {
  const c = useTheme();
  const corner = Math.max(3, Math.round(size / 4));
  if (image) return <Image accessibilityIgnoresInvertColors source={{ uri: image }} style={{ width: size, height: size, borderRadius: corner }} />;
  return <View style={[styles.tile, { width: size, height: size, borderRadius: corner, backgroundColor: color ?? c.muted }]}>
    {size >= 20 ? <Text style={[styles.initials, { fontSize: Math.round(size * 0.42) }]}>{spaceInitials(name)}</Text> : null}
  </View>;
}

/** A member's round avatar, or the first letter of their login. */
export function MemberAvatar({ member, size = 16 }: { member: { avatarUrl: string | null; githubLogin: string | null }; size?: number }) {
  const c = useTheme();
  const round = { width: size, height: size, borderRadius: size / 2 };
  if (member.avatarUrl) return <Image accessibilityIgnoresInvertColors source={{ uri: member.avatarUrl }} style={[round, { backgroundColor: c.surface }]} />;
  return <View style={[styles.tile, round, { backgroundColor: c.surface }]}>
    <Text style={[styles.letter, { color: c.muted, fontSize: Math.max(8, Math.round(size * 0.5)) }]}>{memberName(member).slice(0, 1).toUpperCase()}</Text>
  </View>;
}

const styles = StyleSheet.create({
  tile: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  initials: { color: '#ffffff', ...sans(600) },
  letter: { ...sans(500) },
});
