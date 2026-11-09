import { SymbolView } from 'expo-symbols';
import { ActivityIndicator, View } from 'react-native';

import { prNumberTone, prReview, type PrIcon, type PrPillVariant, type SessionState } from '../lib/status';
import type { PRReviewDecision, PRState } from '@talyn/client/native';
import { useTheme } from '../theme/tokens';
import { Dot, Pill, PrNumber, type Symbol, type Tone } from './UI';

export const PR_ICON: Record<Exclude<PrIcon, 'spinner'>, Symbol> = {
  check: { ios: 'checkmark.circle', android: 'check_circle' },
  warning: { ios: 'exclamationmark.triangle', android: 'warning' },
  failed: { ios: 'xmark.circle', android: 'cancel' },
  merged: { ios: 'arrow.triangle.merge', android: 'merge' },
  closed: { ios: 'xmark.circle', android: 'cancel' },
  review: { ios: 'eye', android: 'visibility' },
  unknown: { ios: 'questionmark.circle', android: 'help' },
  protected: { ios: 'lock.shield', android: 'shield' },
  clock: { ios: 'clock', android: 'schedule' },
  behind: { ios: 'arrow.down.to.line', android: 'arrow_downward' },
  person: { ios: 'person', android: 'person' },
};
const PR_OPEN: Symbol = { ios: 'arrow.triangle.pull', android: 'fork_right' };
const PR_DRAFT: Symbol = { ios: 'pencil.circle', android: 'draft' };
const TIMER: Symbol = { ios: 'timer', android: 'timer' };

const SIZE = 15;

/**
 * The session row's leading mark. Every state has its own shape and colour,
 * mirroring web `SessionStateIcon`, so states read without colour vision.
 */
export function SessionStateIcon({ state }: { state: SessionState }) {
  const c = useTheme();
  const icon = (name: Symbol, color: string) =>
    <SymbolView accessibilityLabel={state.label} name={name} size={SIZE} tintColor={color} />;
  switch (state.kind) {
    case 'failed': return icon({ ios: 'exclamationmark.circle', android: 'error' }, c.destructive);
    case 'starting': return <ActivityIndicator accessibilityLabel={state.label} size={SIZE - 2} color={c.information} />;
    case 'working': return <ActivityIndicator accessibilityLabel={state.label} size={SIZE - 2} color={c.warning} />;
    case 'needs_reply': return <View accessibilityLabel={state.label}><Dot color={c.information} size={10} /></View>;
    case 'background_job': return icon(TIMER, c.success);
    case 'pr_opened': case 'pr_waiting': return icon(PR_OPEN, c.success);
    case 'pr_attention': return icon({ ios: 'exclamationmark.triangle', android: 'warning' }, c.warning);
    case 'ready_to_merge': return icon(PR_ICON.check, c.success);
    case 'draft': return icon(PR_DRAFT, c.muted);
    case 'merged': return icon(PR_ICON.merged, c.merged);
    case 'closed': return icon({ ios: 'xmark.circle', android: 'cancel' }, c.destructive);
    case 'unshipped': return <View accessibilityLabel={state.label}><Dot color={c.muted} size={10} dashed /></View>;
    case 'wakeup': return icon(TIMER, c.muted);
    default: return <View accessibilityLabel={state.label}><Dot color={c.muted} size={9} /></View>;
  }
}

/** One compact PR status pill, from `prStatus` / `prRowStatus`. */
export function PrStatusPill({ variant }: { variant: PrPillVariant }) {
  return <Pill label={variant.label} tone={variant.tone as Tone} spin={variant.icon === 'spinner'}
    icon={variant.icon === 'spinner' ? undefined : PR_ICON[variant.icon]} accessibilityLabel={`Status: ${variant.label}`} />;
}

/** The review verdict pill. Renders nothing when there is nothing to act on, like web `PRReviewPill minimal`. */
export function PrReviewPill({ decision, state }: { decision: PRReviewDecision | undefined; state?: PRState }) {
  const variant = prReview(decision, state);
  if (!variant) return null;
  return <Pill label={variant.label} tone={variant.tone as Tone} icon={PR_ICON[variant.icon as Exclude<PrIcon, 'spinner'>]}
    accessibilityLabel={`Review: ${variant.label}`} />;
}

/** A mono `#123` tinted by PR state, like web `PrPill`. */
export function PrPill({ number, state, draft }: { number: number; state: PRState | string; draft?: boolean }) {
  return <PrNumber number={number} tone={prNumberTone(state, draft) as Tone} />;
}
