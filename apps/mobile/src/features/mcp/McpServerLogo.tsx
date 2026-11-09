import { SymbolView } from 'expo-symbols';
import { Image, StyleSheet, View } from 'react-native';

import { radius, useTheme } from '../../theme/tokens';
import { catalogLogo } from './model';

/** The vendor's logo from the catalog, or a generic plug. */
export function McpServerLogo({ url, catalogHandle, logo }: { url?: string | null; catalogHandle?: string | null; logo?: string }) {
  const c = useTheme();
  const source = logo ?? catalogLogo(url, catalogHandle);
  return <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.tile}>
    {source ? <Image source={{ uri: source }} style={styles.image} resizeMode="contain" />
      : <SymbolView name={{ ios: 'powerplug', android: 'power' }} size={18} tintColor={c.muted} />}
  </View>;
}

const styles = StyleSheet.create({
  tile: { width: 32, height: 32, borderRadius: radius.md, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center', padding: 4 },
  image: { width: 24, height: 24 },
});
