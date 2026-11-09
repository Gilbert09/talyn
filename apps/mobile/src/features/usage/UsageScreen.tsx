import { StyleSheet, View } from 'react-native';

import { useNetwork } from '../../auth/AuthProvider';
import { AppText, EmptyState, Group, Row } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { Bar, Fact, Loading, Page, WebRow } from '../more/Page';
import { useBillingStatus } from './data';
import { GAUGE_TONE, gaugeLevel, leftPercent, usageLines, usageViewOf } from './model';

export function UsageScreen() {
  const status = useBillingStatus();
  const offline = useNetwork() === 'offline';
  const view = usageViewOf(status.data);
  const loaded = status.data !== undefined;
  return <Page refreshing={status.refreshing && loaded} onRefresh={() => { void status.refresh(); }}>
    {status.status === 'loading' && !loaded ? <Loading /> : <StateNotice resource={status} offline={offline} refresh={() => { void status.refresh(); }} />}
    {loaded && !view ? <EmptyState title="Usage is not metered" detail="This account has no box-hour limit." /> : null}
    {view ? <UsageBody view={view} /> : null}
  </Page>;
}

function UsageBody({ view }: { view: NonNullable<ReturnType<typeof usageViewOf>> }) {
  const lines = usageLines(view);
  const level = gaugeLevel(view.usage);
  const left = leftPercent(view.usage.percent, view.usage.exhausted);
  return <>
    <Group title={`${lines.plan} plan`}>
      <View style={styles.gauge}>
        <View style={styles.gaugeHead}>
          <AppText variant="rowTitle" tone={lines.exhausted ? 'destructive' : 'default'}>{lines.exhausted ?? lines.left}</AppText>
          <AppText variant="meta" tone="muted">{lines.reset}</AppText>
        </View>
        <Bar percent={left} tone={GAUGE_TONE[level]} label="Box-hours left" />
        <AppText variant="meta" tone="muted">{lines.used}</AppText>
      </View>
    </Group>
    <Group title="Limits">
      <Fact label="Boxes at the same time" value={lines.boxes} divider={Boolean(lines.team)} />
      {lines.team ? <Fact label="Team" value={lines.team} divider={false} /> : null}
    </Group>
    {lines.credits !== null ? <Group title="Credits" footer={lines.expiring ?? undefined}>
      <Fact label="Balance" value={lines.credits} divider={lines.autoTopup !== null} />
      {lines.autoTopup !== null ? <Fact label="Auto top-up" value={lines.autoTopup} divider={Boolean(lines.autoTopupProblem)} /> : null}
      {lines.autoTopupProblem ? <Row title={lines.autoTopupProblem} divider={false} /> : null}
    </Group> : null}
    <Group footer="Change your plan, buy credits and see invoices in Talyn on the web.">
      <WebRow title="Manage billing on the web" path="/settings/billing" />
    </Group>
  </>;
}

const styles = StyleSheet.create({
  gauge: { gap: 8, paddingVertical: 12, paddingHorizontal: 4 },
  gaugeHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
});
