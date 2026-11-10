import type { MergeQueuePublic, PRRow } from '@talyn/client/native';
import { SymbolView } from 'expo-symbols';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { PR_ICON, PrPill, PrReviewPill, PrStatusPill } from '../../components/Status';
import { AppText, Pill, Row, toneColor, type Symbol, type Tone } from '../../components/UI';
import { prReview, prRowStatus } from '../../lib/status';
import { shortTime } from '../../lib/time';
import { pullRequestRoute } from '../../navigation/routes';
import { useTheme } from '../../theme/tokens';
import { queueBlockedReason, queueChip, reviewRequestLabel, type QueueChip, type QueueChipIcon } from './lists';

export function prTitle(row: PRRow) { return row.summary.title || `Pull request #${row.number}`; }

export type PrRowVariant = 'mine' | 'review' | 'queue';

const CHIP_ICON: Record<Exclude<QueueChipIcon, 'spinner' | 'none'>, Symbol> = {
  zap: { ios: 'bolt', android: 'bolt' },
  merge: PR_ICON.merged,
  clock: PR_ICON.clock,
  review: PR_ICON.review,
  stack: { ios: 'square.stack.3d.up', android: 'layers' },
  session: { ios: 'terminal', android: 'terminal' },
  person: { ios: 'person.crop.circle.badge.checkmark', android: 'how_to_reg' },
  warning: PR_ICON.warning,
};

function QueueChipView({ position, chip }: { position: number; chip: QueueChip }) {
  const c = useTheme();
  const color = toneColor(c, chip.tone as Tone);
  return <View style={styles.queue} accessibilityLabel={`${position > 0 ? `Queue position ${position}. ` : ''}${chip.label}`}>
    {position > 0 ? <AppText variant="caption" style={{ fontVariant: ['tabular-nums'] }}>#{position}</AppText> : null}
    {chip.icon === 'spinner' ? <ActivityIndicator size={10} color={color} />
      : chip.icon !== 'none' ? <SymbolView name={CHIP_ICON[chip.icon]} size={12} tintColor={color} /> : null}
    <AppText variant="caption" numberOfLines={1} style={{ color, flexShrink: 1 }}>{chip.label}</AppText>
  </View>;
}

/**
 * Title, `owner/repo #123 author`, one status pill plus a review pill, and when
 * it last changed. Review requests add who was asked; the merge queue adds the
 * queue position, its status and why it is blocked.
 */
export function PrRow({ row, now, divider = true, variant = 'mine', parentStatus, onLongPress }: {
  row: PRRow; now: number; divider?: boolean; variant?: PrRowVariant; parentStatus?: MergeQueuePublic['status']; onLongPress?(row: PRRow): void;
}) {
  const queue = variant === 'queue';
  // The queue page has no review column, so its status pill carries the review verdict too, as on web.
  const status = prRowStatus(row, queue);
  const decision = row.summary.effectiveReviewDecision ?? row.summary.reviewDecision;
  const review = queue ? null : prReview(decision, row.state);
  const updated = row.summary.updatedAt ?? row.updatedAt;
  const author = row.summary.author || 'Unknown author';
  const requested = variant === 'review' ? reviewRequestLabel(row.summary) : null;
  const chip = queue ? queueChip(row, parentStatus) : null;
  const position = row.mergeQueue?.position ?? 0;
  const blocked = queue ? queueBlockedReason(row.mergeQueue) : null;
  const requestedText = requested ? `${requested.label}${requested.extra > 0 ? ` +${requested.extra}` : ''}` : '';
  return <Row href={pullRequestRoute(row.id)} title={prTitle(row)} divider={divider}
    onLongPress={onLongPress ? () => onLongPress(row) : undefined} longPressLabel={`Link actions for ${prTitle(row)}`}
    accessibilityLabel={[`${prTitle(row)}.`, `${row.owner}/${row.repo} #${row.number} by ${author}.`,
      chip ? `Queue: ${position > 0 ? `position ${position}, ` : ''}${chip.label}.` : '',
      `Status: ${status.label}.`, review ? `Review: ${review.label}.` : '',
      requested ? `Requested: ${requestedText}.` : ''].filter(Boolean).join(' ')}
    trailing={<AppText variant="meta" tone="muted">{shortTime(updated, now)}</AppText>}
    subtitle={<View style={styles.meta}>
      <AppText variant="meta" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>{row.owner}/{row.repo}</AppText>
      <PrPill number={row.number} state={row.state} draft={row.summary.draft} />
      <AppText variant="meta" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>{author}</AppText>
    </View>}>
    {chip ? <QueueChipView position={position} chip={chip} /> : null}
    <View style={styles.pills}>
      <PrStatusPill variant={status} />
      {queue ? null : <PrReviewPill decision={decision} state={row.state} />}
      {requested ? <Pill label={requestedText} icon={requested.direct ? { ios: 'at', android: 'alternate_email' } : { ios: 'person.2', android: 'group' }} /> : null}
    </View>
    {blocked ? <AppText variant="meta" tone="muted" numberOfLines={3}>{blocked}</AppText> : null}
  </Row>;
}

const styles = StyleSheet.create({
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingTop: 2 },
  queue: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
