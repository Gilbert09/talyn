import { useRouter } from 'expo-router';
import { useEffect } from 'react';

import { BootScreen } from '../../components/BootScreen';

/**
 * The return link of a browser flow a settings screen opened (MCP server,
 * Slack or PostHog sign-in). The screen that opened the flow refetches when
 * the browser closes, so this one only steps back to it.
 */
export function ReturnStep({ label }: { label: string }) {
  const router = useRouter();
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/settings');
  }, [router]);
  return <BootScreen label={label} />;
}
