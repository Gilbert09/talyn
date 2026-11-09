import { useEffect } from 'react';
import { AccessibilityInfo } from 'react-native';

import { Notice, type Tone } from './UI';

export function Status({ message, loading = false, tone = 'information' }: { message: string; loading?: boolean; tone?: Tone }) {
  useEffect(() => { AccessibilityInfo.announceForAccessibility(message); }, [message]);
  return <Notice message={message} loading={loading} tone={tone} alert />;
}
