import { PLAN_LIMITS } from '@talyn/shared';
import { StyleSheet, View } from 'react-native';

import { AppText, Group } from '../../components/UI';
import { Bar, Fact } from '../more/Page';
import { GAUGE_TONE, creditDrawToneOf, gaugeLevel, leftPercent, usageLines, type UsageView } from '../usage/model';
import { longDate } from './model';

/** This period's box-hours, the reset date and the running boxes. Mirrors web `UsageCard`. */
export function UsageGauge({ view }: { view: UsageView }) {
  const lines = usageLines(view);
  const level = gaugeLevel(view.usage);
  const credit = lines.credit;
  const left = credit ? credit.leftPercent : leftPercent(view.usage.percent, view.usage.exhausted);
  const barTone = credit ? creditDrawToneOf(credit) : GAUGE_TONE[level];
  const exhaustedDetail = view.usage.exhausted
    ? `Out of hours: new boxes are paused. Running turns finish. ${PLAN_LIMITS[view.tier].creditsAllowed
      ? 'Add credits or turn on auto top-up to start new boxes now.'
      : `New boxes can start again on ${longDate(view.usage.periodEnd)}.`}`
    : null;
  return <Group title="This period">
    <View style={styles.gauge}>
      <View style={styles.head}>
        <AppText variant="rowTitle" tone={view.usage.exhausted ? 'destructive' : credit ? barTone : 'default'}>{lines.exhausted ?? lines.left}</AppText>
        <AppText variant="meta" tone="muted">{lines.reset}</AppText>
      </View>
      <Bar percent={left} tone={barTone} label={credit ? 'Credit left' : 'Box-hours left'} />
      <AppText variant="meta" tone="muted">{lines.used}</AppText>
      {exhaustedDetail ? <AppText variant="meta" tone="destructive">{exhaustedDetail}</AppText> : null}
    </View>
    <Fact label="Boxes at the same time" value={lines.boxes} divider={false} />
  </Group>;
}

const styles = StyleSheet.create({
  gauge: { gap: 8, paddingVertical: 12, paddingHorizontal: 4 },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
});
