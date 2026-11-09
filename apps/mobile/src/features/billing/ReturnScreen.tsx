import { billing } from '@talyn/client/native';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { ScreenContainer } from '../../components/ScreenContainer';
import { AppText, Spinner } from '../../components/UI';
import { billingReturn, returnTitle, type ReturnKind, type ReturnResult } from './returnFlow';

/**
 * Where the browser lands after a checkout or the billing portal. Polar grants
 * the plan by webhook, so this reads the status a few times, then goes back to
 * the plan page, which shows how it went.
 */
export function BillingReturnScreen({ kind, result }: { kind: ReturnKind; result: ReturnResult }) {
  const router = useRouter();
  useEffect(() => {
    let live = true;
    void billingReturn.start(kind, result, () => billing.status()).then(() => {
      if (live) router.dismissTo('/billing');
    });
    return () => { live = false; };
  }, [kind, result, router]);
  return <ScreenContainer>
    <View accessibilityState={{ busy: true }} style={styles.centre}>
      <Spinner size="large" />
      <AppText accessibilityRole="header" variant="heading" style={styles.text}>{result === 'cancel' ? 'Returning to your plan…' : returnTitle(kind)}</AppText>
      <AppText variant="meta" tone="muted" style={styles.text}>This takes a few seconds.</AppText>
    </View>
  </ScreenContainer>;
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  text: { textAlign: 'center' },
});
