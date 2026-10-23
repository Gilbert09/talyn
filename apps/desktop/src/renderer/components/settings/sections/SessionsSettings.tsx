import { useEffect, useState } from 'react';
import {
  FLEET_MODELS,
  WORKBENCH_EFFORTS,
  defaultFleetModelForAgent,
  fleetAgentForModel,
  normaliseBranchPrefix,
  storedFleetModelForAgent,
  type Workspace,
  type WorkbenchAgent,
  type WorkbenchEffort,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { toast } from '../../../stores/toast';
import { useWorkspaceStore } from '../../../stores/workspace';
import type { WorkbenchRuntime } from '../../../lib/readiness';
import { useSessionDefaults, writeSessionDefaults } from '../../../lib/sessionDefaults';
import { SettingRow, SettingToggle, SettingsPage, SettingsSection, SettingsSelect } from '../../ui/settings';
import { InstructionFilesSection } from '../InstructionFilesSection';

const EFFORT_LABEL: Record<WorkbenchEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra-high',
  max: 'Max',
};

function BranchPrefixRow() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const stored = workspaces.find((w) => w.id === currentWorkspaceId)?.settings?.sessionBranchPrefix ?? '';
  const [value, setValue] = useState(stored);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setValue(stored), [stored]);

  const typed = value.trim();
  const example = typed ? `New branches look like ${typed}seattle` : 'New branches use the session name, like seattle';

  const save = async () => {
    if (!currentWorkspaceId) return;
    const checked = normaliseBranchPrefix(value);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setError(null);
    if (checked.value === stored) {
      setValue(checked.value);
      return;
    }
    try {
      await api.workspaces.update(currentWorkspaceId, {
        settings: { sessionBranchPrefix: checked.value } as Workspace['settings'],
      });
      setWorkspaces(
        workspaces.map((w) =>
          w.id === currentWorkspaceId
            ? { ...w, settings: { ...w.settings, sessionBranchPrefix: checked.value } as Workspace['settings'] }
            : w,
        ),
      );
      setValue(checked.value);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the branch prefix');
    }
  };

  return (
    <SettingRow
      label="Branch prefix"
      description={
        <>
          <span>Added to the branch of every new session. A branch you pick yourself keeps its name.</span>
          <span className="mt-0.5 block">{example}</span>
          {error ? (
            <span role="alert" className="mt-0.5 block text-destructive">
              {error}
            </span>
          ) : null}
        </>
      }
    >
      <input
        type="text"
        value={value}
        placeholder="e.g. tom/"
        aria-label="Branch prefix"
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        className="h-7 w-40 rounded-md border border-input bg-background px-2.5 text-xs"
      />
    </SettingRow>
  );
}

/**
 * The model for the default agent, so the list holds only that agent's models.
 * A workspace setting, filed under the agent in `fleetModels`: the new-session
 * page reads it back through `storedFleetModelForAgent`.
 */
function ModelRow({ agent }: { agent: WorkbenchAgent }) {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const [saving, setSaving] = useState(false);
  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const models = FLEET_MODELS.filter((m) => fleetAgentForModel(m.id) === agent);
  const current = storedFleetModelForAgent(workspace?.settings, agent) ?? defaultFleetModelForAgent(agent);
  const agentLabel = agent === 'codex' ? 'Codex' : 'Claude';

  const onChange = async (value: string) => {
    if (!currentWorkspaceId) return;
    const settings = {
      fleetModels: { ...(workspace?.settings?.fleetModels ?? {}), [agent]: value },
    } as Workspace['settings'];
    setSaving(true);
    try {
      await api.workspaces.update(currentWorkspaceId, { settings });
      setWorkspaces(
        workspaces.map((w) =>
          w.id === currentWorkspaceId
            ? { ...w, settings: { ...w.settings, ...settings } as Workspace['settings'] }
            : w,
        ),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the model');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow label="Model" description={`The ${agentLabel} model new sessions start with.`}>
      <SettingsSelect
        value={current}
        disabled={saving}
        onChange={(e) => void onChange(e.target.value)}
        aria-label="Default model"
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </SettingsSelect>
    </SettingRow>
  );
}

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
        <ModelRow agent={defaults.agent} />
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
        <SettingToggle
          label="Internet access"
          description="Sandbox sessions can reach any website, for example to install tools or read docs. When it is off, a session reaches only its repository, the package registries and the agent's API."
          checked={defaults.internetAccess}
          onChange={(internetAccess) => writeSessionDefaults({ internetAccess })}
        />
        <SettingToggle
          label="Open a pull request when the agent is done"
          description="When the agent says the task is finished, Talyn commits, pushes and opens a pull request for this session. Only while the session has no pull request yet."
          checked={defaults.autoCreatePr}
          onChange={(autoCreatePr) => writeSessionDefaults({ autoCreatePr })}
        />
      </SettingsSection>
      <SettingsSection title="Branches">
        <BranchPrefixRow />
      </SettingsSection>
      <InstructionFilesSection />
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
