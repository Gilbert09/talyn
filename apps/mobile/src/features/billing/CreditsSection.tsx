import { billing } from '@talyn/client/native';
import { CREDIT_PACKS, CREDIT_PACK_IDS, formatUsd, type AutoTopupSettings, type BillingStatus, type CreditPackId, type UsageResetOffer } from '@talyn/shared';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText, Button, Field, Group, Input, Row, Segmented, Spinner, Toggle } from '../../components/UI';
import { errorMessage } from '../../lib/errors';
import { radius, useTheme } from '../../theme/tokens';
import { Fact } from '../more/Page';
import type { PurchaseMode } from '../../config';
import { creditLotLines, creditPackOptions, longDate, topupConfigFromDraft, topupDraftFrom, topupSummary, usageResetCount, usageResetDetail, usageResetLabel, type TopupDraft } from './model';

/** Balance, live lots and, when the app may sell, the three packs. Mirrors web `CreditsCard`. */
export function CreditsSection({ status, mode, busyPack, disabled, onBuy }: {
  status: BillingStatus; mode: PurchaseMode; busyPack: CreditPackId | null; disabled: boolean; onBuy(pack: CreditPackId): void;
}) {
  const c = useTheme();
  const credits = status.credits;
  const lots = creditLotLines(status);
  const expiring = credits?.expiringSoonMicros ?? 0;
  return <Group title="Credits" footer="Credits pay for boxes after your included hours run out. They expire 12 months after you buy them.">
    <Fact label="Balance" value={formatUsd(credits?.balanceMicros ?? 0)} divider={expiring > 0 || lots.length > 0 || mode === 'external'} />
    {expiring > 0 ? <Fact label="Expiring soon" tone="warning" value={`${formatUsd(expiring)} in the next 30 days`}
      divider={lots.length > 0 || mode === 'external'} /> : null}
    {lots.map((lot, index) => <Row key={lot.id} title={lot.amount} subtitle={lot.expires}
      divider={index < lots.length - 1 || mode === 'external'} />)}
    {mode === 'external' ? <View style={styles.packs}>
      <AppText variant="meta" tone="muted">Add credits</AppText>
      <View style={styles.packRow}>
        {creditPackOptions().map((pack) => <Pressable key={pack.id} accessibilityRole="button"
          accessibilityLabel={`Buy ${pack.price} of credits. ${pack.detail}`} accessibilityState={{ disabled, busy: busyPack === pack.id }}
          disabled={disabled} onPress={() => onBuy(pack.id)}
          style={({ pressed }) => [styles.pack, { borderColor: c.border, backgroundColor: pressed ? c.surface : c.background, opacity: disabled ? 0.5 : 1 }]}>
          {busyPack === pack.id ? <Spinner /> : <AppText variant="rowTitle">{pack.price}</AppText>}
          <AppText variant="caption" tone="muted">{pack.detail}</AppText>
        </Pressable>)}
      </View>
    </View> : null}
  </Group>;
}

/** Pay the plan price once to get this period's box-hours back. Shown only while the server offers it. */
export function UsageResetSection({ offer, periodEnd, resets, busy, disabled, onReset }: {
  offer: UsageResetOffer; periodEnd: string | null | undefined; resets: number | undefined; busy: boolean; disabled: boolean; onReset(): void;
}) {
  const count = usageResetCount(resets);
  return <Group footer={usageResetDetail(offer, periodEnd)}>
    <Row title={usageResetLabel(offer)} subtitle={count ?? undefined} divider={false} disabled={disabled}
      trailing={busy ? <Spinner /> : undefined} chevron={!busy} onPress={onReset} accessibilityRole="button" />
  </Group>;
}

const PACK_OPTIONS = CREDIT_PACK_IDS.map((id) => ({ value: id, label: formatUsd(CREDIT_PACKS[id].priceMicros, 0) }));

/**
 * Auto top-up: below a balance, buy a pack with the saved card, up to a
 * monthly limit. Read-only when the app may not sell. Mirrors web `AutoTopupForm`.
 */
export function AutoTopupSection({ settings, mode, onSaved }: { settings: AutoTopupSettings; mode: PurchaseMode; onSaved(message: string): void }) {
  const [draft, setDraft] = useState<TopupDraft>(() => topupDraftFrom(settings));
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  // A save elsewhere replaces the stored values.
  const stored = `${settings.enabled}:${settings.triggerMicros}:${settings.pack}:${settings.monthlyLimitMicros}`;
  const latest = useRef(settings);
  latest.current = settings;
  useEffect(() => { setDraft(topupDraftFrom(latest.current)); }, [stored]);
  const failure = settings.lastFailure
    ? `The last automatic top-up failed${settings.lastFailureAt ? ` on ${longDate(settings.lastFailureAt)}` : ''}: ${settings.lastFailure}`
    : null;
  if (mode === 'none') {
    return <Group title="Auto top-up">
      <Fact label="Status" value={topupSummary(settings)} divider={Boolean(failure)} />
      {failure ? <Row title={failure} titleLines={4} divider={false} /> : null}
    </Group>;
  }
  const save = async () => {
    const result = topupConfigFromDraft(draft);
    if ('errors' in result) { setErrors(result.errors); return; }
    setErrors([]);
    setSaving(true);
    try {
      await billing.autoTopup.update(result.config);
      onSaved(result.config.enabled ? 'Auto top-up is on' : 'Auto top-up is off');
    } catch (error) {
      setErrors([errorMessage(error, 'Could not save auto top-up.')]);
    } finally {
      setSaving(false);
    }
  };
  return <Group title="Auto top-up" footer={`Spent by auto top-up this month: ${formatUsd(settings.monthSpentMicros)}.`}>
    {failure ? <Row title={failure} titleLines={4} subtitle="Buy credits now, or save these settings to try again." /> : null}
    <Row title="Buy credits automatically when the balance is low" titleLines={3}
      trailing={<Toggle accessibilityLabel="Turn on auto top-up" value={draft.enabled} disabled={saving}
        onValueChange={(enabled) => setDraft({ ...draft, enabled })} />} />
    <View style={styles.form}>
      <Field label="When the balance is below ($)">
        <Input accessibilityLabel="Trigger balance in dollars" keyboardType="decimal-pad" value={draft.trigger} editable={!saving}
          onChangeText={(trigger) => setDraft({ ...draft, trigger })} />
      </Field>
      <Field label="Buy">
        <Segmented options={PACK_OPTIONS} value={draft.pack} accessibilityLabel="Top-up amount"
          onChange={(pack) => setDraft({ ...draft, pack })} />
      </Field>
      <Field label="At most per month ($)">
        <Input accessibilityLabel="Monthly limit in dollars" keyboardType="decimal-pad" value={draft.limit} editable={!saving}
          onChangeText={(limit) => setDraft({ ...draft, limit })} />
      </Field>
      {errors.map((error) => <AppText key={error} accessibilityRole="alert" variant="meta" tone="destructive">{error}</AppText>)}
      <Button title="Save auto top-up" size="sm" loading={saving} disabled={saving} onPress={() => { void save(); }} />
    </View>
  </Group>;
}

const styles = StyleSheet.create({
  packs: { gap: 8, paddingVertical: 12, paddingHorizontal: 4 },
  packRow: { flexDirection: 'row', gap: 8 },
  pack: { flex: 1, borderWidth: 1, borderRadius: radius.md, padding: 10, gap: 4, minHeight: 64 },
  form: { gap: 12, paddingVertical: 12, paddingHorizontal: 4 },
});
