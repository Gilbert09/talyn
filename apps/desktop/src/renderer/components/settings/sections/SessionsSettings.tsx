import { DEFAULT_FLEET_MODEL_ID, FLEET_MODELS, WORKBENCH_EFFORTS, type WorkbenchAgent, type WorkbenchEffort } from '@talyn/shared';
import type { WorkbenchRuntime } from '../../../lib/readiness';
import { useSessionDefaults, writeSessionDefaults } from '../../../lib/sessionDefaults';
import { SettingRow, SettingToggle, SettingsPage, SettingsSection, SettingsSelect } from '../../ui/settings';
import { WorkspaceModelSelector } from '../WorkspaceModelSelector';

const EFFORT_LABEL: Record<WorkbenchEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra-high',
  max: 'Max',
};

export function SessionsSettings() {
  const defaults = useSessionDefaults();

  return (
    <SettingsPage title="Sessions" description="What a new session starts with. You can still change each one before you start it.">
      <SettingsSection title="Defaults">
        <SettingRow label="Runtime" description="Where new sessions run. When it is unavailable, Talyn uses the other one.">
          <SettingsSelect
            value={defaults.runtime}
            onChange={(e) => writeSessionDefaults({ runtime: e.target.value as WorkbenchRuntime })}
            aria-label="Default runtime"
          >
            <option value="sandbox">Sandbox</option>
            <option value="local">This computer</option>
          </SettingsSelect>
        </SettingRow>
        <SettingRow label="Agent">
          <SettingsSelect
            value={defaults.agent}
            onChange={(e) => writeSessionDefaults({ agent: e.target.value as WorkbenchAgent })}
            aria-label="Default agent"
          >
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </SettingsSelect>
        </SettingRow>
        {/* A workspace setting, not a device one: the same choice drives fleet runs for PR tasks. */}
        <WorkspaceModelSelector
          providerType="selfhosted"
          title="Model"
          description="Which model fleet runs use, and therefore which agent runs them — the model carries its vendor. Sonnet 5 handles the mechanical work (rebases, conflicts, re-running CI) at a fraction of Opus's cost."
          models={FLEET_MODELS}
          defaultId={DEFAULT_FLEET_MODEL_ID}
          settingKey="fleetModel"
        />
        <SettingRow label="Reasoning effort">
          <SettingsSelect
            value={defaults.effort}
            onChange={(e) => writeSessionDefaults({ effort: e.target.value as WorkbenchEffort })}
            aria-label="Default reasoning effort"
          >
            {WORKBENCH_EFFORTS.map((e) => (
              <option key={e} value={e}>
                {EFFORT_LABEL[e]}
              </option>
            ))}
          </SettingsSelect>
        </SettingRow>
        <SettingToggle
          label="Start in plan mode"
          description="The agent plans first and waits for you before it changes code."
          checked={defaults.planMode}
          onChange={(planMode) => writeSessionDefaults({ planMode })}
        />
      </SettingsSection>
      <SettingsSection title="Notifications">
        <SettingToggle
          label="Notify me when an agent finishes"
          description="A desktop notification when a chat stops (done, an error, or a question) while Talyn is in the background."
          checked={defaults.notifyOnFinish}
          onChange={(notifyOnFinish) => writeSessionDefaults({ notifyOnFinish })}
        />
      </SettingsSection>
    </SettingsPage>
  );
}
