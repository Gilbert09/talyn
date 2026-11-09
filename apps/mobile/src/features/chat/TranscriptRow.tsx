import { StyleSheet, View } from 'react-native';

import { AppText } from '../../components/UI';
import { NativeText } from '../../components/Workflow';
import { longTime, shortTime } from '../../lib/time';
import { radius, useTheme } from '../../theme/tokens';
import type { TranscriptRow as Row } from '../../workflow/model';

/** One transcript entry. Phase 2 replaces this with rendered markdown and tool rows. */
export function TranscriptRow({ row, now }: { row: Row; now: number }) {
  const c = useTheme();
  const time = row.timestamp ? shortTime(row.timestamp, now) : '';
  const meta = [row.author === 'System' ? 'Talyn' : row.author === 'Agent' ? 'Agent' : '', time, row.streaming ? 'Streaming' : ''].filter(Boolean).join(' · ');
  if (row.author === 'You') {
    return <View style={styles.userWrap} accessibilityLabel={`You${row.timestamp ? `, ${longTime(row.timestamp)}` : ''}`}>
      <View style={[styles.bubble, { backgroundColor: c.surface }]}><NativeText text={row.text} /></View>
      {time ? <AppText variant="caption" tone="muted">{time}</AppText> : null}
    </View>;
  }
  return <View style={[styles.flat, row.author === 'System' && { opacity: 0.85 }]} accessibilityLiveRegion="none">
    {meta ? <AppText variant="caption" tone="muted">{meta}</AppText> : null}
    <NativeText text={row.text} />
  </View>;
}

const styles = StyleSheet.create({
  userWrap: { alignItems: 'flex-end', gap: 4, paddingLeft: 40, paddingVertical: 6 },
  bubble: { borderRadius: radius.lg, paddingHorizontal: 12, paddingVertical: 8, maxWidth: '100%' },
  flat: { gap: 4, paddingVertical: 6 },
});
