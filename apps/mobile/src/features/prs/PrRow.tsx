import type { MergeQueuePublic, PRRow } from '@talyn/client/native';
import { SymbolView } from 'expo-symbols';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { PR_ICON } from '../../components/Status';
import { AppText, PrNumber, Row, toneColor, type Symbol, type Tone } from '../../components/UI';
import { prReview, prRowStatus, type PrIcon, type PrPillVariant } from '../../lib/status';
import { shortTime } from '../../lib/time';
import { pullRequestRoute } from '../../navigation/routes';
import { useTheme } from '../../theme/tokens';
import { queueBlockedReason, queueChip, reviewRequestLabel, type QueueChipIcon } from './lists';

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
const STACK_ICON = CHIP_ICON.stack;
const DRAFT_ICON: Symbol = { ios: 'pencil', android: 'edit' };

/** The row's one status mark, in its tone. A spinner while checks run. */
function StatusGlyph({ status }: { status: PrPillVariant }) {
  const c = useTheme();
  const color = toneColor(c, status.tone as Tone);
  if (status.icon === 'spinner') return <ActivityIndicator size={16} color={color} importantForAccessibility="no" />;
  return <SymbolView name={PR_ICON[status.icon as Exclude<PrIcon, 'spinner'>]} size={18} tintColor={color} />;
}

/** One small fact on the second meta line: an optional icon and short muted text. Only the icon carries colour. */
function Fact({ label, icon, tone = 'muted', spin = false }: { label: string; icon?: Symbol; tone?: Tone; spin?: boolean }) {
  const c = useTheme();
  const color = toneColor(c, tone);
  return <View style={styles.fact}>
    {spin ? <ActivityIndicator size={10} color={color} /> : icon ? <SymbolView name={icon} size={12} tintColor={color} /> : null}
    <AppText variant="caption" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>{label}</AppText>
  </View>;
}

/**
 * A calm, symbol-led PR row: the status mark, the title and when it last
 * changed, `owner/repo #123 · author`, then short facts. Review requests add
 * who was asked; the merge queue adds the position, its status and why it is blocked.
 */
export function PrRow({ row, now, divider = true, variant = 'mine', parentStatus, stackedOn, onLongPress }: {
  row: PRRow; now: number; divider?: boolean; variant?: PrRowVariant; parentStatus?: MergeQueuePublic['status'];
  /** The PR number this row is stacked on, when the list shows that PR too. */
  stackedOn?: number | null; onLongPress?(row: PRRow): void;
}) {
  const queue = variant === 'queue';
  // The queue page has no review column, so its status carries the review verdict too, as on web.
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
  const draft = Boolean(row.summary.draft) && row.state === 'open';
  return <Row href={pullRequestRoute(row.id)} title={prTitle(row)} divider={divider} leadingWidth={20}
    leading={<StatusGlyph status={status} />}
    onLongPress={onLongPress ? () => onLongPress(row) : undefined} longPressLabel={`Link actions for ${prTitle(row)}`}
    accessibilityLabel={[`${prTitle(row)}.`, `${row.owner}/${row.repo} #${row.number} by ${author}.`,
      chip ? `Queue: ${position > 0 ? `position ${position}, ` : ''}${chip.label}.` : '',
      `Status: ${status.label}.`, draft ? 'Draft.' : '', review ? `Review: ${review.label}.` : '',
      requested ? `Requested: ${requestedText}.` : '', stackedOn ? `Stacked on #${stackedOn}.` : ''].filter(Boolean).join(' ')}
    trailing={<AppText variant="meta" tone="muted">{shortTime(updated, now)}</AppText>}
    subtitle={<View style={styles.meta}>
      <AppText variant="meta" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>{row.owner}/{row.repo}</AppText>
      <PrNumber number={row.number} plain />
      <AppText variant="meta" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>· {author}</AppText>
    </View>}>
    <View style={styles.facts}>
      {chip ? <View style={styles.fact}>
        {position > 0 ? <AppText variant="caption" tone="muted" style={{ fontVariant: ['tabular-nums'] }}>#{position}</AppText> : null}
        <Fact label={chip.label} tone={chip.tone as Tone} spin={chip.icon === 'spinner'}
          icon={chip.icon === 'spinner' || chip.icon === 'none' ? undefined : CHIP_ICON[chip.icon]} />
      </View> : null}
      <Fact label={status.label} />
      {draft ? <Fact label="Draft" icon={DRAFT_ICON} /> : null}
      {review ? <Fact label={review.label} tone={review.tone as Tone} icon={PR_ICON[review.icon as Exclude<PrIcon, 'spinner'>]} /> : null}
      {requested ? <Fact label={requestedText} icon={requested.direct ? { ios: 'at', android: 'alternate_email' } : { ios: 'person.2', android: 'group' }} /> : null}
      {stackedOn ? <Fact label={`Stacked on #${stackedOn}`} icon={STACK_ICON} /> : null}
    </View>
    {blocked ? <AppText variant="meta" tone="muted" numberOfLines={3}>{blocked}</AppText> : null}
  </Row>;
}

const styles = StyleSheet.create({
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  facts: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 10, rowGap: 2 },
  fact: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
});
