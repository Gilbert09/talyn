import { billing } from '@talyn/client/native';
import { PLAN_LIMITS, type CreditPackId, type SellableTier } from '@talyn/shared';
import { useRouter } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { useNetwork } from '../../auth/AuthProvider';
import { AppText, Banner, EmptyState, Group, Notice, Pill, Row, useToast } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { Fact, Loading, Page } from '../more/Page';
import { usageViewOf, type UsageView } from '../usage/model';
import { AutoTopupSection, CreditsSection } from './CreditsSection';
import { appPurchaseMode, requestCheckout, requestCreditCheckout, requestPortal, runHostedFlow, useBillingStatus, useOrders } from './data';
import {
  billingErrorCopy, changedPlanMessage, longDate, orderAmount, planCards, planSummary, reasonNotice, showsPeriodSwitch,
  type BillingReason, type Period, type PlanAction,
} from './model';
import { PeriodSwitch, PlanCardView } from './PlanCards';
import { billingReturn, type ReturnKind } from './returnFlow';
import { UsageGauge } from './UsageGauge';

/** Waits this long for the deep link to open the return screen before the app opens it itself. */
const RETURN_HANDOFF_MS = 400;

/**
 * Plan and credits. Mirrors web Settings → Billing: the plan, this period's
 * box-hours, the plans to compare, credits, auto top-up and past orders.
 * Purchases open the web checkout in the browser unless the build sells nothing.
 */
export function BillingScreen({ reason = null }: { reason?: BillingReason | null }) {
  const router = useRouter();
  const status = useBillingStatus();
  const offline = useNetwork() === 'offline';
  const mode = appPurchaseMode();
  const view = usageViewOf(status.data);
  const loaded = status.data !== undefined;
  const orders = useOrders(Boolean(view));
  const returned = useSyncExternalStore(billingReturn.subscribe, billingReturn.getSnapshot, billingReturn.getSnapshot);
  const toast = useToast(3000);
  const [period, setPeriod] = useState<Period>('monthly');
  const [busy, setBusy] = useState<string | null>(null);

  // The banner belongs to this visit of the page.
  useEffect(() => () => { if (billingReturn.getSnapshot().phase === 'done') billingReturn.clear(); }, []);

  const refresh = () => { void status.refresh(); void orders.refresh(); };

  const showError = (error: unknown, context: Parameters<typeof billingErrorCopy>[1], title: string) => {
    const copy = billingErrorCopy(error, context);
    Alert.alert(title, copy.message, copy.portal && mode === 'external'
      ? [{ text: 'Close', style: 'cancel' }, { text: 'Manage subscription', onPress: () => { void openPortal(); } }]
      : [{ text: 'Close', style: 'cancel' }]);
  };

  const hosted = async (kind: ReturnKind, url: string) => {
    const result = await runHostedFlow(url, status.data);
    if (result === 'returned' && kind !== 'portal') {
      // On Android the app link can open the return screen by itself. Open it only when it has not.
      setTimeout(() => {
        if (!billingReturn.active(kind)) router.push({ pathname: '/billing/return', params: { kind } });
      }, RETURN_HANDOFF_MS);
    } else {
      refresh();
    }
  };

  const openPortal = async () => {
    setBusy('portal');
    try {
      const { url } = await requestPortal();
      await hosted('portal', url);
    } catch (error) {
      showError(error, { action: 'portal' }, 'Could not open billing');
    } finally {
      setBusy(null);
    }
  };

  const buyPlan = async (plan: SellableTier, chosen: Period) => {
    setBusy(`checkout:${plan}`);
    try {
      const { url } = await requestCheckout(plan, chosen);
      await hosted('checkout', url);
    } catch (error) {
      showError(error, { action: 'checkout', plan }, 'Could not start the checkout');
    } finally {
      setBusy(null);
    }
  };

  const changePlan = async (plan: SellableTier, chosen: Period, wasTier: UsageView['tier']) => {
    setBusy(`change:${plan}`);
    try {
      await billing.changePlan({ to: plan, period: chosen });
      await status.refresh();
      toast.show(changedPlanMessage(plan, chosen, wasTier));
    } catch (error) {
      showError(error, { action: 'change', plan }, 'Could not change the plan');
    } finally {
      setBusy(null);
    }
  };

  const buyCredits = async (pack: CreditPackId) => {
    setBusy(`credits:${pack}`);
    try {
      const { url } = await requestCreditCheckout(pack);
      await hosted('credits', url);
    } catch (error) {
      showError(error, { action: 'credits' }, 'Could not start the checkout');
    } finally {
      setBusy(null);
    }
  };

  const act = (action: PlanAction) => {
    if (!view || mode === 'none') return;
    if (action.kind === 'portal') { void openPortal(); return; }
    if (action.kind === 'checkout') { void buyPlan(action.plan, action.period); return; }
    if (action.confirm) {
      Alert.alert('Switch to annual?', action.confirm, [
        { text: 'Cancel', style: 'cancel', isPreferred: true },
        { text: 'Confirm switch', onPress: () => { void changePlan(action.plan, action.period, view.tier); } },
      ]);
      return;
    }
    void changePlan(action.plan, action.period, view.tier);
  };

  const notice = reason && view ? reasonNotice(reason, view, mode) : null;
  const banner = returned.phase === 'done' ? returned.banner : null;
  return <View style={{ flex: 1 }}>
    <Page refreshing={status.refreshing && loaded} onRefresh={refresh}>
      {notice ? <Notice message={`${notice.title}. ${notice.body}`} tone="warning">
        {notice.sizeLink ? <Row title="Change the box size" subtitle="Repositories" chevron divider={false} href="/repositories" /> : null}
      </Notice> : null}
      {banner ? banner.tone === 'success'
        ? <Notice message={banner.message} tone="success" alert />
        : <Banner message={banner.message} tone={banner.tone} action="Dismiss" onAction={() => billingReturn.clear()} /> : null}
      {status.status === 'loading' && !loaded ? <Loading /> : <StateNotice resource={status} offline={offline} refresh={refresh} />}
      {loaded && status.data && !status.data.billingEnabled
        ? <EmptyState title="Billing is not enabled" detail="This account has no plan limits." /> : null}
      {loaded && status.data?.billingEnabled && !view
        ? <EmptyState title="Plan details are not available" detail="This server does not report box-hour usage yet." /> : null}
      {view ? <BillingBody view={view} mode={mode} period={period} setPeriod={setPeriod} busy={busy} offline={offline}
        onAction={act} onBuyCredits={(pack) => { void buyCredits(pack); }} onPortal={() => { void openPortal(); }}
        onTopupSaved={(message) => { toast.show(message); void status.refresh(); }} orders={orders.data ?? []} /> : null}
    </Page>
    {toast.element}
  </View>;
}

function BillingBody({ view, mode, period, setPeriod, busy, offline, onAction, onBuyCredits, onPortal, onTopupSaved, orders }: {
  view: UsageView; mode: ReturnType<typeof appPurchaseMode>; period: Period; setPeriod(period: Period): void; busy: string | null;
  offline: boolean; onAction(action: PlanAction): void; onBuyCredits(pack: CreditPackId): void; onPortal(): void;
  onTopupSaved(message: string): void; orders: NonNullable<ReturnType<typeof useOrders>['data']>;
}) {
  const { status, tier } = view;
  const summary = planSummary(view);
  const cards = planCards(view, period, mode);
  const blocked = busy !== null || offline;
  const creditsAllowed = PLAN_LIMITS[tier].creditsAllowed;
  const canManage = mode === 'external' && status.planSource === 'subscription';
  return <>
    <Group title="Your plan">
      <Row title={summary.label} subtitle={<AppText variant="meta" tone="muted">{summary.detail}</AppText>}
        trailing={<Pill label={summary.state} tone={summary.stateTone === 'muted' ? 'success' : summary.stateTone} />}
        divider={Boolean(summary.renews || summary.notes.length || status.team)} />
      {summary.renews ? <Fact label="Renews" value={summary.renews.replace('Renews ', '')} divider={summary.notes.length > 0} /> : null}
      {summary.notes.map((note, index) => <Row key={note} title={note} titleLines={4} divider={index < summary.notes.length - 1} />)}
    </Group>
    {summary.pastDue ? <Banner tone="destructive"
      message="Your last payment failed. Update your payment method to keep your plan. The plan drops to Free if the retries run out."
      action={canManage ? 'Manage subscription' : undefined} onAction={canManage ? onPortal : undefined} actionDisabled={blocked} /> : null}
    <UsageGauge view={view} />
    <View style={styles.plans}>
      <AppText accessibilityRole="header" variant="section" tone="muted" style={styles.label}>Plans</AppText>
      {showsPeriodSwitch(view, mode) ? <PeriodSwitch value={period} onChange={setPeriod} /> : null}
      {cards.map((card) => <PlanCardView key={card.tier} card={card} disabled={blocked}
        busy={Boolean(card.action && busy !== null && busy.endsWith(card.action.kind === 'portal' ? 'portal' : `:${card.action.plan}`))}
        onAction={onAction} />)}
      {!creditsAllowed && mode === 'external'
        ? <AppText variant="meta" tone="muted" style={styles.label}>Credits and auto top-up come with Pro. Credits let you start new boxes after your included hours run out.</AppText> : null}
    </View>
    {creditsAllowed ? <CreditsSection status={status} mode={mode} disabled={blocked}
      busyPack={busy?.startsWith('credits:') ? busy.slice('credits:'.length) as CreditPackId : null} onBuy={onBuyCredits} /> : null}
    {creditsAllowed && status.autoTopup ? <AutoTopupSection settings={status.autoTopup} mode={mode} onSaved={onTopupSaved} /> : null}
    {canManage ? <Group footer="Cancel, change your card, or move to a smaller plan in the billing portal.">
      <Row title="Manage subscription" chevron divider={false} disabled={blocked} onPress={onPortal} accessibilityRole="link" />
    </Group> : null}
    {orders.length ? <Group title="Order history">
      {orders.map((order, index) => <Row key={order.id} title={order.productName ?? 'Talyn'}
        subtitle={[longDate(order.createdAt), order.invoiceNumber].filter(Boolean).join(' · ')}
        trailing={<View style={styles.order}>
          <AppText variant="meta">{orderAmount(order.amount, order.currency)}</AppText>
          {order.status !== 'paid' ? <Pill label={order.status.replace(/_/g, ' ')} /> : null}
        </View>}
        divider={index < orders.length - 1} />)}
    </Group> : null}
  </>;
}


const styles = StyleSheet.create({
  plans: { gap: 10 },
  label: { paddingHorizontal: 4, paddingTop: 8 },
  order: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
