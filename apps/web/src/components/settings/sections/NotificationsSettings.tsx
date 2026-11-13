import { useEffect, useRef, useState } from 'react';
import {
  MOBILE_NOTIFICATION_CATEGORIES,
  type MobileNotificationCategory,
  type MobileNotificationPreferences,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { useSessionDefaults, writeSessionDefaults } from '../../../lib/sessionDefaults';
import { useWorkspaceStore } from '../../../stores/workspace';
import { getMergeBlockedNotifyEnabled, setMergeBlockedNotifyEnabled } from '../../../hooks/useApi';
import { Button } from '../../ui/button';
import { SettingRow, SettingToggle, SettingsPage, SettingsSection } from '../../ui/settings';

/** Same names as the mobile app's notification settings. */
export const PHONE_NOTIFICATION_LABELS: Record<MobileNotificationCategory, string> = {
  session_update: 'Session updates',
  pr_review: 'PR reviews',
  ci_failure: 'CI failures',
  merge_ready: 'Ready to merge',
  human_gate: 'Human input',
};

/** Edits wait this long so a run of changes costs one save. */
export const PHONE_SAVE_DEBOUNCE_MS = 600;

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function validPhonePreferences(value: MobileNotificationPreferences): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value.timezone });
  } catch {
    return false;
  }
  return TIME.test(value.quietHours.start) && TIME.test(value.quietHours.end);
}

function currentPermission(): NotificationPermission {
  return typeof Notification !== 'undefined' ? Notification.permission : 'denied';
}

export function NotificationsSettings() {
  return (
    <SettingsPage
      title="Notifications"
      description="What Talyn tells you about, in this browser and on your phone"
    >
      <BrowserNotifications />
      <PhoneNotifications />
    </SettingsPage>
  );
}

/** Per browser: session defaults and localStorage. */
function BrowserNotifications() {
  const defaults = useSessionDefaults();
  const [notifyBlocked, setNotifyBlocked] = useState(getMergeBlockedNotifyEnabled());
  const [permission, setPermission] = useState<NotificationPermission>(currentPermission());

  // Ask for OS permission on enable, so the first real alert does not race the prompt.
  const requestPermission = async () => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
    try {
      setPermission(await Notification.requestPermission());
    } catch {
      // ignore
    }
  };

  return (
    <SettingsSection
      title="In this browser"
      description={
        permission === 'denied' ? (
          <span className="text-yellow-500">
            Notifications are blocked for this site. Allow them in your browser settings to
            receive them. In-app alerts still show.
          </span>
        ) : undefined
      }
    >
      <SettingToggle
        label="Notify me when an agent finishes"
        description="A browser notification when a chat stops (done, an error, or a question) while Talyn is in the background."
        checked={defaults.notifyOnFinish}
        onChange={(notifyOnFinish) => {
          writeSessionDefaults({ notifyOnFinish });
          if (notifyOnFinish) void requestPermission();
        }}
      />
      <SettingToggle
        label="Notify me when a merge-queue PR is blocked"
        description="A browser notification and an in-app alert when a PR in the merge queue gives up after its retry budget and needs manual intervention. Click the notification to jump to it."
        checked={notifyBlocked}
        onChange={(next) => {
          setMergeBlockedNotifyEnabled(next);
          setNotifyBlocked(next);
          if (next) void requestPermission();
        }}
      />
    </SettingsSection>
  );
}

type LoadState = 'loading' | 'ready' | 'failed';
type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'failed' | 'invalid';

/**
 * Push alerts for the mobile app. The backend keeps one row per person and
 * workspace, so these are the same settings the phone edits.
 */
function PhoneNotifications() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const [draft, setDraft] = useState<MobileNotificationPreferences | null>(null);
  const [providerAvailable, setProviderAvailable] = useState(true);
  const [load, setLoad] = useState<LoadState>('loading');
  const [save, setSave] = useState<SaveState>('idle');
  const [reloadKey, setReloadKey] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const unsaved = useRef<MobileNotificationPreferences | null>(null);
  // Saves run one after another, so the server keeps the last edit.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(true);

  const send = (next: MobileNotificationPreferences) => {
    const run = chain.current.then(() => api.mobileNotifications.updatePreferences(next));
    chain.current = run.catch(() => undefined);
    return run;
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setDraft(null);
    setSave('idle');
    if (!workspaceId) {
      setLoad('failed');
      return;
    }
    setLoad('loading');
    api.mobileNotifications
      .getPreferences(workspaceId)
      .then((result) => {
        if (cancelled) return;
        setDraft(result.preferences);
        setProviderAvailable(result.providerAvailable);
        setLoad('ready');
      })
      .catch(() => {
        if (!cancelled) setLoad('failed');
      });
    return () => {
      cancelled = true;
      // Leaving the page or the workspace must not drop an edit that waits for its timer.
      clearTimeout(timer.current);
      const pending = unsaved.current;
      unsaved.current = null;
      if (pending) void send(pending).catch(() => undefined);
    };
  }, [workspaceId, reloadKey]);

  const change = (next: MobileNotificationPreferences) => {
    setDraft(next);
    clearTimeout(timer.current);
    if (!validPhonePreferences(next)) {
      unsaved.current = null;
      setSave('invalid');
      return;
    }
    unsaved.current = next;
    setSave('pending');
    timer.current = setTimeout(() => {
      unsaved.current = null;
      setSave('saving');
      send(next)
        .then((result) => {
          if (!mounted.current) return;
          setProviderAvailable(result.providerAvailable);
          // A newer edit is on its way; its own save reports the result.
          if (unsaved.current) return;
          setSave('saved');
        })
        .catch(() => {
          if (mounted.current && !unsaved.current) setSave('failed');
        });
    }, PHONE_SAVE_DEBOUNCE_MS);
  };

  const description = (
    <>
      Push alerts for this workspace in the Talyn mobile app. Each phone must also allow
      notifications in the app.
      {!providerAvailable && (
        <span className="mt-1 block text-yellow-500">
          Push delivery is not available on this server, so phones get no alerts.
        </span>
      )}
    </>
  );

  if (!draft) {
    return (
      <SettingsSection title="On your phone" description={description}>
        {load === 'failed' ? (
          <SettingRow label="Phone notification settings did not load.">
            <Button
              variant="outline"
              size="sm"
              disabled={!workspaceId}
              onClick={() => setReloadKey((k) => k + 1)}
            >
              Retry
            </Button>
          </SettingRow>
        ) : (
          <SettingRow label={<span className="text-muted-foreground">Loading…</span>} />
        )}
      </SettingsSection>
    );
  }

  const off = !draft.enabled;
  const device = localTimezone();
  const timeInput =
    'h-7 rounded-md border border-input bg-background px-2 text-xs tabular-nums disabled:opacity-60';

  return (
    <>
      <SettingsSection title="On your phone" description={description}>
        <SettingToggle
          label="Enable workspace notifications"
          checked={draft.enabled}
          onChange={(enabled) => change({ ...draft, enabled })}
        />
        {MOBILE_NOTIFICATION_CATEGORIES.map((category) => (
          <SettingToggle
            key={category}
            label={PHONE_NOTIFICATION_LABELS[category]}
            className="pl-8"
            checked={draft.categories[category]}
            disabled={off}
            onChange={(value) =>
              change({ ...draft, categories: { ...draft.categories, [category]: value } })
            }
          />
        ))}
        <SettingToggle
          label="Only when I'm away from my computer"
          description="Talyn on your computer shows the alert instead while you are using it."
          checked={draft.onlyWhenAway}
          disabled={off}
          onChange={(onlyWhenAway) => change({ ...draft, onlyWhenAway })}
        />
      </SettingsSection>
      <SettingsSection title="Quiet hours" description="No phone alerts between these times.">
        <SettingToggle
          label="Quiet hours"
          checked={draft.quietHours.enabled}
          disabled={off}
          onChange={(enabled) =>
            change({
              ...draft,
              quietHours: { ...draft.quietHours, enabled },
              // A schedule left on the server default reads in this computer's timezone.
              ...(enabled && draft.timezone === 'UTC' && device !== 'UTC' ? { timezone: device } : {}),
            })
          }
        />
        <SettingRow label="From">
          <input
            type="time"
            aria-label="Quiet hours start"
            className={timeInput}
            value={draft.quietHours.start}
            disabled={off || !draft.quietHours.enabled}
            onChange={(e) => change({ ...draft, quietHours: { ...draft.quietHours, start: e.target.value } })}
          />
        </SettingRow>
        <SettingRow label="To">
          <input
            type="time"
            aria-label="Quiet hours end"
            className={timeInput}
            value={draft.quietHours.end}
            disabled={off || !draft.quietHours.enabled}
            onChange={(e) => change({ ...draft, quietHours: { ...draft.quietHours, end: e.target.value } })}
          />
        </SettingRow>
        <SettingRow label="Timezone" description={draft.timezone}>
          {draft.timezone !== device && (
            <Button
              variant="outline"
              size="sm"
              disabled={off}
              onClick={() => change({ ...draft, timezone: device })}
            >
              Use {device}
            </Button>
          )}
        </SettingRow>
      </SettingsSection>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {save === 'invalid' && 'Use a valid timezone and times in HH:MM format.'}
        {save === 'failed' && <span className="text-destructive">Settings could not be saved. Try again.</span>}
        {(save === 'pending' || save === 'saving') && 'Saving…'}
        {save === 'saved' && 'Saved.'}
      </p>
    </>
  );
}
