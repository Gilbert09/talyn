import { usePathname, useRouter, type Href } from 'expo-router';
import { useShareIntent } from 'expo-share-intent';
import { useEffect } from 'react';

import { useAuth } from '../../auth/AuthProvider';
import { trackEvent } from '../../lib/analytics';
import { rememberShare, SHARE_ROUTE } from '../../navigation/intents';
import { sharedKind, sharedPrompt } from './sharedPrompt';

/**
 * "Share to Talyn": a link or text shared from another app opens the
 * new-session composer with it. iOS opens the app with a link to `/share`;
 * Android opens the app with no link. In both, the native module then sends
 * the shared item here. When nobody is signed in, the item waits as a pending
 * intent and opens after sign-in and the workspace choice.
 */
export function ShareIntentBridge() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();
  const signedIn = useAuth().status === 'signedIn';
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    if (!hasShareIntent) return;
    const prompt = sharedPrompt(shareIntent);
    resetShareIntent();
    if (!prompt) return;
    const href = rememberShare(prompt) as Href;
    trackEvent('share_received', { content: sharedKind(shareIntent), chars: prompt.length, signed_in: signedIn });
    if (!signedIn) return;
    if (pathname === SHARE_ROUTE) router.replace(href);
    else router.push(href);
  }, [hasShareIntent, shareIntent, resetShareIntent, signedIn, pathname, router]);
  return null;
}
