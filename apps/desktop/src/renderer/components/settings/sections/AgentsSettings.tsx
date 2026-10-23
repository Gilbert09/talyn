import { useEffect, useState } from 'react';
import { DEFAULT_FLEET_SWITCH_AT_PERCENT, normaliseFleetSwitchAtPercent, type Workspace } from '@talyn/shared';
import { getWorkbenchBridge } from '../../../lib/workbenchBridge';
import { api } from '../../../lib/api';
import { useSessionDefaults, writeSessionDefaults } from '../../../lib/sessionDefaults';
import { useWorkspaceStore } from '../../../stores/workspace';
import { LocalAgentStatus } from '../../onboarding/steps/LocalAgentStatus';
import { SettingRow, SettingToggle, SettingsPage, SettingsSection } from '../../ui/settings';
import { SettingsGroup } from '../SettingsGroup';
import { ProviderConnectCards } from '../providerCards';

export function FleetSwitchThresholdRow() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const stored = workspaces.find((w) => w.id === currentWorkspaceId)?.settings?.fleetSwitchAtPercent ?? DEFAULT_FLEET_SWITCH_AT_PERCENT;
  const [value, setValue] = useState(String(stored));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => setValue(String(stored)), [stored]);

  const save = async () => {
    if (!currentWorkspaceId || saving) return;
    const checked = normaliseFleetSwitchAtPercent(value.trim() === '' ? NaN : Number(value));
    if (!checked.ok) {
      setError('Enter a whole number from 50 to 100.');
      return;
    }
    setError(null);
    if (checked.value === stored) return;
    setSaving(true);
    try {
      await api.workspaces.update(currentWorkspaceId, {
        settings: { fleetSwitchAtPercent: checked.value } as Workspace['settings'],
      });
      setWorkspaces(workspaces.map((workspace) => workspace.id === currentWorkspaceId
        ? { ...workspace, settings: { ...workspace.settings, fleetSwitchAtPercent: checked.value } as Workspace['settings'] }
        : workspace));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the switch threshold');
    } finally {
      setSaving(false);
    }
  };

  return <SettingRow
    label="Switch accounts at"
    description={<>
      <span>When an account's usage reaches this share of any of its limits, Talyn moves new and running work to the next account in the list. 100% switches only when a limit is reached.</span>
      {error && <span role="alert" className="mt-1 block text-destructive">{error}</span>}
    </>}
  >
    <div className="flex items-center gap-1">
      <input type="number" min={50} max={100} step={1} aria-label="Switch accounts at" aria-invalid={Boolean(error)} value={value} disabled={saving}
        onChange={(event) => { setValue(event.target.value); setError(null); }}
        onBlur={() => void save()}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
        className="h-7 w-16 rounded-md border border-input bg-background px-2 text-xs" />
      <span className="text-xs text-muted-foreground">%</span>
    </div>
  </SettingRow>;
}

export function AgentsSettings() {
  const defaults = useSessionDefaults();

  return (
    <SettingsPage title="Agents" description="Where your agents run: in Talyn's cloud, or on this computer.">
      <section className="space-y-2">
        <h2 className="text-[13px] font-medium">Cloud agents</h2>
        <p className="text-xs text-muted-foreground">Run tasks and open PRs in the cloud. Connect one or more.</p>
        <div className="space-y-3"><ProviderConnectCards /></div>
      </section>
      <SettingsSection title="Pull requests">
        <SettingToggle
          label="Open a PR when the agent is done"
          description="The agent opens a pull request when it thinks the work is finished. New sessions use this."
          checked={defaults.autoCreatePr}
          onChange={(autoCreatePr) => writeSessionDefaults({ autoCreatePr })}
        />
      </SettingsSection>
      <SettingsSection title="Fleet switching">
        <FleetSwitchThresholdRow />
      </SettingsSection>
      {getWorkbenchBridge() && (
        <SettingsGroup title="On this computer">
          <LocalAgentStatus recheck />
        </SettingsGroup>
      )}
    </SettingsPage>
  );
}
