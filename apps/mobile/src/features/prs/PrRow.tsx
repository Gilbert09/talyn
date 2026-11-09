import type { PRRow } from '@talyn/client/native';
import { StyleSheet, View } from 'react-native';

import { PrPill, PrReviewPill, PrStatusPill } from '../../components/Status';
import { AppText, Row } from '../../components/UI';
import { prReview, prRowStatus } from '../../lib/status';
import { shortTime } from '../../lib/time';
import { pullRequestRoute } from '../../navigation/routes';

export function prTitle(row: PRRow) { return row.summary.title || `Pull request #${row.number}`; }

/** Title, `owner/repo #123 author`, one status pill plus a review pill, and when it last changed. */
export function PrRow({ row, now, divider = true }: { row: PRRow; now: number; divider?: boolean }) {
  const status = prRowStatus(row);
  const decision = row.summary.effectiveReviewDecision ?? row.summary.reviewDecision;
  const review = prReview(decision, row.state);
  const updated = row.summary.updatedAt ?? row.updatedAt;
  const author = row.summary.author || 'Unknown author';
  return <Row href={pullRequestRoute(row.id)} title={prTitle(row)} divider={divider}
    accessibilityLabel={[`${prTitle(row)}.`, `${row.owner}/${row.repo} #${row.number} by ${author}.`, `Status: ${status.label}.`,
      review ? `Review: ${review.label}.` : ''].filter(Boolean).join(' ')}
    trailing={<AppText variant="meta" tone="muted">{shortTime(updated, now)}</AppText>}
    subtitle={<View style={styles.meta}>
      <AppText variant="meta" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>{row.owner}/{row.repo}</AppText>
      <PrPill number={row.number} state={row.state} draft={row.summary.draft} />
      <AppText variant="meta" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>{author}</AppText>
    </View>}>
    <View style={styles.pills}><PrStatusPill variant={status} /><PrReviewPill decision={decision} state={row.state} /></View>
  </Row>;
}

const styles = StyleSheet.create({
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingTop: 2 },
});
