import { usePathname, useSegments } from 'expo-router';
import { PostHogProvider } from 'posthog-react-native';
import { type PropsWithChildren, useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';

import { getAnalyticsClient, initAnalytics, isAnalyticsConfigured, screenPattern, trackScreen } from '../lib/analytics';

/** Never wait longer than this for analytics before the first screen. Events still flow once it is ready. */
const INIT_WAIT_MS = 1500;

// Touches are autocaptured from component names and test IDs only. Text children and
// accessibility labels can hold titles and prompts.
const AUTOCAPTURE = { captureTouches: true, captureScreens: false, propsToCapture: ['testID', 'ph-label'] };

/** Start analytics as early as the module loads, so the saved opt-out is read before the first screen. */
if (isAnalyticsConfigured()) void initAnalytics();

/**
 * Whether the app may draw its first screen. A build with no key is ready at once.
 * Otherwise the app waits for the client, so touch autocapture wraps the tree from
 * the start and the tree never remounts to add it.
 */
export function useAnalyticsReady(): boolean {
  const [ready, setReady] = useState(() => !isAnalyticsConfigured() || getAnalyticsClient() !== null);
  useEffect(() => {
    if (ready) return;
    let done = false;
    const finish = () => { if (!done) { done = true; setReady(true); } };
    const timer = setTimeout(finish, INIT_WAIT_MS);
    void initAnalytics().then(finish);
    return () => { done = true; clearTimeout(timer); };
  }, [ready]);
  return ready;
}

/** Wraps the app with touch autocapture when a client exists, and records a screen view per route. */
export function AnalyticsRoot({ children }: PropsWithChildren) {
  // Read once: the tree must not remount when a late client arrives.
  const [client] = useState(getAnalyticsClient);
  const content = <><ScreenTracker />{children}</>;
  if (!client) return content;
  return <PostHogProvider client={client} autocapture={AUTOCAPTURE} style={styles.root}>{content}</PostHogProvider>;
}

/** A `$screen` per route change, named by the route pattern (`/pulls/[id]`), never the path with ids. */
function ScreenTracker() {
  const pathname = usePathname();
  const segments = useSegments();
  const pattern = screenPattern(segments);
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (last.current === pathname) return;
    last.current = pathname;
    trackScreen(pattern);
  }, [pathname, pattern]);
  return null;
}

const styles = StyleSheet.create({ root: { flex: 1 } });
