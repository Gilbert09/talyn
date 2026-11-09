import { useRouter } from 'expo-router';
import { useEffect } from 'react';

import { BootScreen } from '../../src/components/BootScreen';

/**
 * The GitHub install flow's return link. The screen that opened the flow
 * listens for it and refreshes, so this one only steps back to that screen.
 */
export default function GithubCallbackScreen() {
  const router = useRouter();
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);
  return <BootScreen label="Checking GitHub" />;
}
