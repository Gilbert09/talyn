import { insights } from '@talyn/client/native';
import { PLAN_TIER_LABELS, formatBoxHoursUsage, type InsightsRangePreset, type InsightsResponseBySection, type InsightsSection } from '@talyn/shared';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { useWorkspaceName } from '../../components/ScreenHeader';
import { AppText, Banner, Group, Row, Segmented } from '../../components/UI';
import { radius, useTheme } from '../../theme/tokens';
import { Bar, Intro, Page, WebRow } from '../more/Page';
import { useRemote, type Remote } from '../more/useRemote';
import { shortDate } from '../usage/model';
import { DEFAULT_RANGE, RANGE_OPTIONS, dayShares, insightTiles, repositoryBars, type Tile } from './model';

function useSection<S extends InsightsSection>(section: S, workspaceId: string | null, range: InsightsRangePreset): Remote<InsightsResponseBySection[S]> {
  return useRemote<InsightsResponseBySection[S]>(workspaceId ? `insights:${section}:${workspaceId}:${range}` : null,
    () => insights.get(section, { workspaceId: workspaceId ?? '', range }));
}

export function InsightsScreen() {
  const workspaceId = useWorkspace().selected;
  const name = useWorkspaceName();
  const offline = useNetwork() === 'offline';
  const [range, setRange] = useState<InsightsRangePreset>(DEFAULT_RANGE);
  const compute = useSection('compute', workspaceId, range);
  const agents = useSection('agents', workspaceId, range);
  const output = useSection('output', workspaceId, range);
  const speed = useSection('speed', workspaceId, range);
  const top = useSection('top', workspaceId, range);
  const sections = [compute, agents, output, speed, top] as const;
  const refresh = () => { sections.forEach((section) => { void section.refresh(); }); };
  const failed = sections.some((section) => ['error', 'unauthorized'].includes(section.status));
  const tiles = insightTiles({ compute: compute.data, agents: agents.data, output: output.data, speed: speed.data });
  const loading = (remote: Remote<unknown>) => remote.data === undefined && remote.status === 'loading';
  return <Page refreshing={sections.some((section) => section.refreshing && section.data !== undefined)} onRefresh={refresh}>
    <Intro>Usage for {name ?? 'this workspace'}. Days are in UTC.</Intro>
    <Segmented accessibilityLabel="Date range" value={range} onChange={(value: InsightsRangePreset) => setRange(value)} options={RANGE_OPTIONS} />
    {offline ? <Banner message="You are offline. Connect to load insights." tone="warning" /> : null}
    {failed && !offline ? <Banner message="Some figures could not load." tone="destructive" action="Try again" onAction={refresh} /> : null}
    <View style={styles.grid}>
      {tiles.map((tile) => <StatTile key={tile.key} tile={tile} pending={tile.value === null && sections.some(loading)} />)}
    </View>
    {compute.data && compute.data.days.length ? <DayBars days={compute.data.days} /> : null}
    {top.data ? <Group title="Top repositories by box time">
      {top.data.repositoriesByHours.length === 0 ? <Row title="Nothing in this range" divider={false} />
        : repositoryBars(top.data.repositoriesByHours).map((row, index, rows) => <Row key={row.key} title={row.label} titleLines={1}
          divider={index < rows.length - 1} trailing={<AppText variant="meta" tone="muted">{row.value}</AppText>}>
          <Bar percent={row.share} label={`${row.label} box time`} height={4} />
        </Row>)}
    </Group> : null}
    {compute.data?.period ? <Group title={`Your plan: ${PLAN_TIER_LABELS[compute.data.period.tier]}`}
      footer="This covers your whole account, across all your workspaces.">
      <Row title={`${formatBoxHoursUsage(compute.data.period.usedWsec, compute.data.period.includedWsec)} used`} divider={false}
        subtitle={`${shortDate(compute.data.period.periodStart)} to ${shortDate(compute.data.period.periodEnd)}`}>
        <Bar percent={compute.data.period.includedWsec > 0 ? (compute.data.period.usedWsec / compute.data.period.includedWsec) * 100 : 0}
          label="Included box-hours used" />
      </Row>
    </Group> : null}
    <Group footer="Charts by kind, agent, model and speed are on the web.">
      <WebRow title="Open insights on the web" path="/insights" />
    </Group>
  </Page>;
}

function StatTile({ tile, pending }: { tile: Tile; pending: boolean }) {
  const c = useTheme();
  return <View accessible accessibilityLabel={`${tile.label}: ${tile.value ?? (pending ? 'loading' : 'unavailable')}`}
    style={[styles.tile, { backgroundColor: c.paper, borderColor: c.border }]}>
    <AppText variant="caption" tone="muted" numberOfLines={1}>{tile.label}</AppText>
    <AppText variant="heading" numberOfLines={1} adjustsFontSizeToFit tone={tile.value === null ? 'muted' : 'default'}>
      {tile.value ?? (pending ? '…' : 'No data')}</AppText>
    {tile.hint ? <AppText variant="caption" tone="muted" numberOfLines={1}>{tile.hint}</AppText> : null}
  </View>;
}

function DayBars({ days }: { days: InsightsResponseBySection['compute']['days'] }) {
  const c = useTheme();
  const shares = dayShares(days);
  const busiest = Math.max(...shares.map((day) => day.hours));
  return <Group title="Box-hours per day">
    <View accessible accessibilityLabel={`Box-hours per day. Busiest day: ${busiest.toFixed(1)} box-hours.`} style={styles.days}>
      {shares.map((day) => <View key={day.date} style={styles.dayColumn}>
        <View style={[styles.dayBar, { height: `${Math.max(day.share, day.hours > 0 ? 4 : 0)}%`, backgroundColor: c.primary }]} />
      </View>)}
    </View>
    <View style={styles.dayLabels}>
      <AppText variant="caption" tone="muted">{shortDate(`${shares[0]?.date}T00:00:00Z`)}</AppText>
      <AppText variant="caption" tone="muted">{shortDate(`${shares[shares.length - 1]?.date}T00:00:00Z`)}</AppText>
    </View>
  </Group>;
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: { flexBasis: '47%', flexGrow: 1, gap: 2, padding: 12, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth },
  days: { height: 72, flexDirection: 'row', alignItems: 'flex-end', gap: 2, paddingTop: 12 },
  dayColumn: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  dayBar: { width: '100%', borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  dayLabels: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
});
