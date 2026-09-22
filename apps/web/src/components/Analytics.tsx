import { api } from '../lib/api';
import { useEffect, useRef } from 'react';
import { useAuth, takePendingLogin } from './auth/AuthProvider';
import { useWorkspaceStore } from '../stores/workspace';
import {
  getAnalyticsOptOut,
  identifyAnalyticsUser,
  registerSuperProperties,
  resetAnalyticsUser,
  trackEvent,
} from '../lib/analytics';
import { consumeLogoutReason } from '../lib/logoutReason';

/**
 * PostHog identity and lifecycle events, mirroring the desktop's `Analytics`
 * component (apps/desktop/src/renderer/App.tsx).
 *
 * Its own module here because the web App.tsx is a router shell. The one
 * addition is the `client` super property — with two front ends reporting into
 * one project, every event needs to say which it came from or the funnels
 * silently merge.
 */
export function Analytics() {
  const { user } = useAuth();
  const activePanel = useWorkspaceStore((s) => s.activePanel);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const userId = user?.id;
  const email = user?.email;
  const githubLogin = user?.user_metadata?.user_name as string | undefined;
  // First identify of a mount is session restore, not a fresh login — only
  // track logged_in when the user id appears after being absent.
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  const previousPanelRef = useRef<string | null>(null);

  useEffect(() => {
    if (!userId || !currentWorkspaceId) return;
    let acknowledged: boolean | null = null;
    let resumeRequested = false;
    let running = false;
    const sync = async () => {
      const optedOut = getAnalyticsOptOut();
      if ((!optedOut && !resumeRequested) || running || acknowledged === optedOut) return;
      running = true;
      try {
        await api.workspaces.recordRankingEvents(currentWorkspaceId, {
          enabled: !optedOut, resume: !optedOut, events: [],
        });
        acknowledged = optedOut;
        if (!optedOut) resumeRequested = false;
      } catch { /* Retry when the connection returns. */ }
      finally {
        running = false;
        if (optedOut !== getAnalyticsOptOut()) void sync();
      }
    };
    void sync();
    const timer = setInterval(() => void sync(), 30_000);
    const preferenceChanged = () => {
      acknowledged = null;
      resumeRequested = !getAnalyticsOptOut();
      void sync();
    };
    window.addEventListener('talyn-analytics-preference-changed', preferenceChanged);
    return () => {
      clearInterval(timer);
      window.removeEventListener('talyn-analytics-preference-changed', preferenceChanged);
    };
  }, [userId, currentWorkspaceId]);


  useEffect(() => {
    const prevUserId = prevUserIdRef.current;
    prevUserIdRef.current = userId;
    if (userId) {
      identifyAnalyticsUser(userId, { email, github_login: githubLogin });
      // `prevUserId === null` is how the desktop spots a fresh login, and it
      // cannot work here: OAuth is a full-page redirect, so the ref is a new
      // `undefined` by the time we come back. takePendingLogin bridges that
      // gap via sessionStorage — set before leaving for GitHub, consumed once
      // on return. A restored session has no marker and is not a login.
      if (prevUserId === null || takePendingLogin()) trackEvent('logged_in');
    } else {
      // Distinguish "no session yet" (undefined) from "session ended"
      // by recording null once auth has resolved to signed-out.
      prevUserIdRef.current = null;
      if (prevUserId) {
        trackEvent('logged_out', { reason: consumeLogoutReason() });
        // Only reset on a REAL sign-out. This effect also runs on first
        // render, before auth resolves, where userId is simply not known yet
        // — resetting there churned the anonymous distinct_id and started a
        // fresh replay session on every single page load.
        resetAnalyticsUser();
      }
    }
  }, [userId, email, githubLogin]);

  // Active workspace as a super property — every event (incl. autocapture)
  // carries it, instead of threading it through each call site.
  useEffect(() => {
    if (currentWorkspaceId) {
      registerSuperProperties({ workspace_id: currentWorkspaceId });
    }
  }, [currentWorkspaceId]);

  useEffect(() => {
    if (activePanel) {
      trackEvent('panel_viewed', {
        panel: activePanel,
        previous_panel: previousPanelRef.current,
      });
      previousPanelRef.current = activePanel;
    }
  }, [activePanel]);

  return null;
}
