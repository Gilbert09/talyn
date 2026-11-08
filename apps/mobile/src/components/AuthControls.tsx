import { useEffect } from 'react';
import { AccessibilityInfo, ActivityIndicator, Text } from 'react-native';

import { useShellColors } from './ShellScreen';

export function Status({ message, loading = false }: { message: string; loading?: boolean }) {
  const colors = useShellColors();
  useEffect(() => { AccessibilityInfo.announceForAccessibility(message); }, [message]);
  return <>
    {loading ? <ActivityIndicator accessibilityLabel="Loading" color={colors.accent} /> : null}
    <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: colors.text, fontSize: 17, lineHeight: 26 }}>{message}</Text>
  </>;
}
