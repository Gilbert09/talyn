import { Stack, useLocalSearchParams } from 'expo-router';

import { BillingScreen } from '../../src/features/billing/BillingScreen';
import { billingReasonOf } from '../../src/features/billing/model';
import { detailOptions } from '../../src/features/more/Page';
import { DetailRoute } from '../../src/navigation/DetailRoute';

export default function Screen() {
  const params = useLocalSearchParams();
  return <DetailRoute list="/settings">
    <Stack.Screen options={detailOptions('Plan and billing')} />
    <BillingScreen reason={billingReasonOf(params.reason ?? params.note)} />
  </DetailRoute>;
}
