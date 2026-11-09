import { SymbolView } from 'expo-symbols';
import { StyleSheet, View } from 'react-native';

import { AppText, Button, Pill, Segmented } from '../../components/UI';
import { radius, useTheme } from '../../theme/tokens';
import type { Period, PlanAction, PlanCard } from './model';

const PERIODS = [{ value: 'monthly' as const, label: 'Monthly' }, { value: 'annual' as const, label: 'Annual' }];

export function PeriodSwitch({ value, onChange }: { value: Period; onChange(value: Period): void }) {
  return <Segmented options={PERIODS} value={value} onChange={onChange} accessibilityLabel="Billing period" />;
}

/** One plan to compare: price, what it includes, and the move to it when there is one. */
export function PlanCardView({ card, busy, disabled, onAction }: {
  card: PlanCard; busy: boolean; disabled: boolean; onAction(action: PlanAction): void;
}) {
  const c = useTheme();
  return <View accessibilityLabel={`${card.label} plan${card.current ? ', your plan' : ''}`}
    style={[styles.card, { backgroundColor: c.paper, borderColor: card.current ? c.primary : c.border }]}>
    <View style={styles.head}>
      <AppText variant="rowTitle" style={{ flex: 1 }}>{card.label}</AppText>
      {card.badge ? <Pill label={card.badge} tone="primary" /> : null}
    </View>
    <View style={styles.price}>
      <AppText variant="heading">{card.price}</AppText>
      {card.priceDetail ? <AppText variant="meta" tone="muted">{card.priceDetail}</AppText> : null}
    </View>
    <View style={styles.features}>
      {card.features.map((feature) => <View key={feature} style={styles.feature}>
        <SymbolView name={{ ios: 'checkmark', android: 'check' }} size={13} tintColor={c.muted} />
        <AppText variant="meta" tone="muted">{feature}</AppText>
      </View>)}
    </View>
    {card.note ? <AppText variant="meta" tone="muted">{card.note}</AppText> : null}
    {card.action ? <Button title={card.action.label} size="sm" loading={busy} disabled={disabled}
      variant={card.action.kind === 'portal' ? 'secondary' : 'primary'} onPress={() => onAction(card.action!)} /> : null}
  </View>;
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.lg, padding: 14, gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  price: { flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
  features: { gap: 4 },
  feature: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
