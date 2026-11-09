import { Stack, useLocalSearchParams } from 'expo-router';

import { BillingReturnScreen } from '../../src/features/billing/ReturnScreen';
import { returnKindOf, returnResultOf } from '../../src/features/billing/returnFlow';
import { DetailRoute } from '../../src/navigation/DetailRoute';

// The browser comes back here: `/billing/return?kind=checkout|credits|portal&result=success|cancel`.
export default function Screen() {
  const params = useLocalSearchParams();
  return <DetailRoute list="/billing">
    <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
    <BillingReturnScreen kind={returnKindOf(params.kind)} result={returnResultOf(params.result)} />
  </DetailRoute>;
}
