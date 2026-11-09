import { SymbolView } from 'expo-symbols';

import { Group, Row } from '../../components/UI';
import { useFeatures } from '../../lib/features';
import { useTheme } from '../../theme/tokens';
import { useBillingStatus } from '../usage/data';
import { visibleNavItems } from './navItems';

/** The visible app pages, with the answers they depend on. A drawer or a hub screen draws them. */
export function useNavItems() {
  const features = useFeatures();
  const billing = useBillingStatus();
  return visibleNavItems(features, billing.data);
}

/** The app pages as one settings-style group of rows. */
export function MoreList({ title }: { title?: string }) {
  const c = useTheme();
  const items = useNavItems();
  return <Group title={title}>
    {items.map((item, index) => <Row key={item.key} title={item.label} href={item.route} chevron divider={index < items.length - 1}
      leading={<SymbolView name={item.icon} size={16} tintColor={c.muted} />} />)}
  </Group>;
}
