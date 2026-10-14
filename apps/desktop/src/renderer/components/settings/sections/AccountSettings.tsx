import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { cn } from '../../../lib/utils';
import {
  isAnalyticsConfigured,
  getAnalyticsOptOut,
  setAnalyticsOptOut,
} from '../../../lib/analytics';
import { useAuth } from '../../auth/AuthProvider';
import { Button } from '../../ui/button';
import { SettingRow, SettingsPage, SettingsSection } from '../../ui/settings';

export function AccountSettings() {
  const { user, signOut } = useAuth();
  const analyticsConfigured = isAnalyticsConfigured();
  // Toggle semantics: checked = sharing enabled = NOT opted out.
  const [shareAnalytics, setShareAnalytics] = useState(!getAnalyticsOptOut());

  const toggleShareAnalytics = (next: boolean) => {
    setAnalyticsOptOut(!next);
    setShareAnalytics(next);
  };

  return (
    <SettingsPage title="Account">
      <SettingsSection title="Account">
        <SettingRow
          label={<span className="text-xs text-muted-foreground">Signed in as</span>}
          description={<span className="text-[13px] font-medium text-foreground">{user?.email ?? '—'}</span>}
        >
          <Button variant="outline" size="sm" onClick={signOut}>
            <LogOut className="w-3.5 h-3.5" /> Sign out
          </Button>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Privacy">
        <SettingRow
          label="Share usage data & session replays"
          description={
            <>
              Helps us improve Talyn by collecting usage events, errors, and
              session replays of the app UI.
              {!analyticsConfigured && (
                <span className="mt-1 block">
                  Analytics isn&apos;t enabled in this build — nothing is
                  collected either way.
                </span>
              )}
            </>
          }
        >
          <button
            type="button"
            role="switch"
            aria-checked={shareAnalytics}
            disabled={!analyticsConfigured}
            onClick={() => toggleShareAnalytics(!shareAnalytics)}
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
              shareAnalytics && analyticsConfigured ? 'bg-primary' : 'bg-muted',
              !analyticsConfigured && 'opacity-50 cursor-not-allowed'
            )}
          >
            <span
              className={cn(
                'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                shareAnalytics && analyticsConfigured
                  ? 'translate-x-4'
                  : 'translate-x-0.5'
              )}
            />
          </button>
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
}
