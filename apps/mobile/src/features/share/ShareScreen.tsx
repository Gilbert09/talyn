import { Redirect, useRouter, type Href } from 'expo-router';
import { useEffect } from 'react';

import { useAuth } from '../../auth/AuthProvider';
import { BootScreen } from '../../components/BootScreen';
import { pendingShare } from '../../navigation/intents';
import { HOME } from '../../navigation/routes';

/** How long the page waits for the shared item before it gives up. The native module normally sends it at once. */
export const SHARE_WAIT_MS = 4000;

/**
 * The iOS share extension opens this page. `ShareIntentBridge` replaces it with
 * the new-session composer when the shared item arrives. Signed out, it goes to
 * sign-in, and the item opens after sign-in.
 */
export function ShareScreen() {
  const signedIn = useAuth().status === 'signedIn';
  const router = useRouter();
  useEffect(() => {
    if (!signedIn) return;
    const waiting = pendingShare();
    if (waiting) { router.replace(waiting as Href); return; }
    const timer = setTimeout(() => { if (router.canGoBack()) router.back(); else router.replace(HOME); }, SHARE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [signedIn, router]);
  if (!signedIn) return <Redirect href="/" />;
  return <BootScreen label="Opening what you shared" />;
}
