import { useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { api } from '../../../lib/api';
import { getSupabase, isSupabaseConfigured } from '../../../lib/supabase';
import { setLogoutReason } from '../../../lib/logoutReason';
import { useIsDevBuild } from '../../../hooks/useIsDevBuild';
import { DeveloperInternals } from '../../panels/DeveloperInternals';
import { Button } from '../../ui/button';
import { SettingRow, SettingsPage, SettingsSection } from '../../ui/settings';

export function DeveloperSettings() {
  // The account wipe is a dev-workflow tool (reset to a first-run state);
  // production users should never see a one-click "delete everything".
  const isDevBuild = useIsDevBuild();
  const [wipeArmed, setWipeArmed] = useState(false);
  const [wiping, setWiping] = useState(false);

  async function handleWipe() {
    setWiping(true);
    try {
      await api.users.wipeMe();
    } catch {
      // The wipe severs our own auth mid-flight, so a late failure here is
      // expected — proceed with the local reset regardless.
    }
    try {
      localStorage.clear();
    } catch {
      // Privacy mode — nothing persisted to clear anyway.
    }
    if (isSupabaseConfigured()) {
      setLogoutReason('account_wiped');
      await getSupabase().auth.signOut({ scope: 'local' });
    }
    window.location.reload();
  }

  return (
    <SettingsPage title="Developer" description="Your account's GitHub rate limits, agents and recent activity">
      <DeveloperInternals />

      {isDevBuild && (
        <SettingsSection title="Danger zone">
          <SettingRow
            label={
              <span className="flex items-center gap-2 font-medium text-destructive">
                <Trash2 className="w-3.5 h-3.5" />
                Wipe account &amp; start fresh
              </span>
            }
            description="Deletes your user profile, every workspace it owns (integrations, watched repos, PRs, tasks), and this app's local storage, then signs you out. The next sign-in runs onboarding from scratch."
          >
            {wipeArmed ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setWipeArmed(false)}
                  disabled={wiping}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleWipe}
                  disabled={wiping}
                >
                  {wiping ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    'Yes, wipe everything'
                  )}
                </Button>
              </>
            ) : (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setWipeArmed(true)}
              >
                Wipe…
              </Button>
            )}
          </SettingRow>
        </SettingsSection>
      )}
    </SettingsPage>
  );
}
