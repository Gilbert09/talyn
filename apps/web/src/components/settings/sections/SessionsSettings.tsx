import { useEffect, useState } from 'react';
import {
  DEFAULT_AUTO_ARCHIVE_IDLE_DAYS,
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
import { useWorkspaceStore, type SidebarOrder } from '../../../stores/workspace';
import { useFleetModelCatalog } from '../../../lib/fleetModelCatalog';
import { useSessionDefaults, writeSessionDefaults } from '../../../lib/sessionDefaults';
import { useActiveSpace } from '../../../lib/spaces';
import type { SpaceRef } from '../../../stores/spaces';
import { SettingRow, SettingToggle, SettingsPage, SettingsSection, SettingsSelect } from '../../ui/settings';

const EFFORT_LABEL: Record<WorkbenchEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra-high',
  max: 'Max',
};

const IDLE_DAY_OPTIONS = [0, 1, 3, 7, 14, 30];

/**
 * The workspace whose session settings this page edits. A space session runs
 * in my home workspace for the team, so in a space that is the one, when it
 * is mine. Else the current workspace.
 */
export function sessionSettingsWorkspaceId(
  space: Pick<SpaceRef, 'team'> | null,
  workspaces: Pick<Workspace, 'id'>[],
  currentWorkspaceId: string | null,
): string | null {
  const home = space?.team.homeWorkspaceId;
  return home && workspaces.some((w) => w.id === home) ? home : currentWorkspaceId;
}

function useSettingsWorkspaceId(): string | null {
  const space = useActiveSpace();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  return sessionSettingsWorkspaceId(space, workspaces, currentWorkspaceId);
}

/** In a space: one line that names the workspace these settings belong to. */
function SpaceSettingsNote() {
  const space = useActiveSpace();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const workspace = space ? workspaces.find((w) => w.id === space.team.homeWorkspaceId) : undefined;
  if (!space || !workspace) return null;
  return (
    <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground" data-attr="sessions-settings-space-note">
      Sessions you start in {space.space.name} use the settings of {workspace.name}.
    </p>
  );
}

function LimitResumeSection() {
  const id = useSettingsWorkspaceId();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const workspace = workspaces.find((w) => w.id === id);
  const [saving, setSaving] = useState(false);
  const save = async (value: boolean) => {
    if (!id) return;
    setSaving(true);
    try {
      await api.workspaces.update(id, { settings: { autoResumeOnLimit: value } });
      setWorkspaces(workspaces.map((w) => w.id === id
        ? { ...w, settings: { ...w.settings, autoResumeOnLimit: value } } : w));
    } catch {
      toast.error('Could not save the setting');
    } finally {
      setSaving(false);
    }
  };
  return <SettingsSection title="Usage limits">
    <SettingToggle label="Continue when an agent hits its limit"
      description="Move the chat to your other agent, or wait for the limit to reset and continue."
      checked={workspace?.settings?.autoResumeOnLimit !== false} disabled={saving || !workspace}
      onChange={(value) => void save(value)} />
  </SettingsSection>;
}

function AutoArchiveSection() {
  const currentWorkspaceId = useSettingsWorkspaceId();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const storedIdleDays = workspace?.settings?.autoArchiveIdleDays === undefined
    ? DEFAULT_AUTO_ARCHIVE_IDLE_DAYS : (workspace.settings.autoArchiveIdleDays ?? 0);
  const storedOnMerge = workspace?.settings?.autoArchiveOnMerge !== false;
  const [idleDays, setIdleDays] = useState(storedIdleDays);
  const [onMerge, setOnMerge] = useState(storedOnMerge);
  const [saving, setSaving] = useState(false);

  useEffect(() => setIdleDays(storedIdleDays), [storedIdleDays]);
  useEffect(() => setOnMerge(storedOnMerge), [storedOnMerge]);

  const save = async (settings: Workspace['settings']) => {
    if (!currentWorkspaceId) return;
    setSaving(true);
    try {
      await api.workspaces.update(currentWorkspaceId, { settings });
      setWorkspaces(workspaces.map((w) => w.id === currentWorkspaceId
        ? { ...w, settings: { ...w.settings, ...settings } as Workspace['settings'] } : w));
    } catch (e) {
      setIdleDays(storedIdleDays);
      setOnMerge(storedOnMerge);
      toast.error(e instanceof Error ? e.message : 'Could not save auto-archive settings');
    } finally {
      setSaving(false);
    }
  };

  const idleOptions = IDLE_DAY_OPTIONS.includes(idleDays)
    ? IDLE_DAY_OPTIONS : [...IDLE_DAY_OPTIONS, idleDays].sort((a, b) => a - b);

  return (
    <SettingsSection title="Auto-archive">
      <SettingRow
        label="Archive idle sessions"
        description="A session with no messages, terminal input or scripts for this long is archived. Its work is saved first."
      >
        <SettingsSelect
          value={idleDays}
          disabled={saving}
          onChange={(e) => {
            const value = Number(e.target.value);
            setIdleDays(value);
            void save({ autoArchiveIdleDays: value });
          }}
          aria-label="Archive idle sessions"
        >
          {idleOptions.map((days) => (
            <option key={days} value={days}>
              {days === 0 ? 'Off' : `After ${days} ${days === 1 ? 'day' : 'days'}${days === 7 ? ' (default)' : ''}`}
            </option>
          ))}
        </SettingsSelect>
      </SettingRow>
      <SettingToggle
        label="Archive when the pull request merges"
        description="When a session's pull request merges, the session is archived."
        checked={onMerge}
        disabled={saving}
        onChange={(value) => {
          setOnMerge(value);
          void save({ autoArchiveOnMerge: value });
        }}
      />
    </SettingsSection>
  );
}

function BranchPrefixRow() {
  const currentWorkspaceId = useSettingsWorkspaceId();
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

function ClaudeCoAuthorshipSection() {
  const currentWorkspaceId = useSettingsWorkspaceId();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const [saving, setSaving] = useState(false);

  const save = async (value: boolean) => {
    if (!currentWorkspaceId) return;
    setSaving(true);
    try {
      await api.workspaces.update(currentWorkspaceId, { settings: { claudeCoAuthoredBy: value } });
      setWorkspaces(workspaces.map((w) => w.id === currentWorkspaceId
        ? { ...w, settings: { ...w.settings, claudeCoAuthoredBy: value } } : w));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the co-author setting');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title="Commits">
      <SettingToggle
        label="Add Claude as a co-author"
        description="Add Claude as a co-author to commits that it creates."
        checked={workspace?.settings?.claudeCoAuthoredBy !== false}
        disabled={saving || !workspace}
        onChange={(value) => void save(value)}
      />
    </SettingsSection>
  );
}

/**
 * The model for the default agent, so the list holds only that agent's models.
 * A workspace setting, filed under the agent in `fleetModels`: the new-session
 * page reads it back through `storedFleetModelForAgent`.
 */
function ModelRow({ agent }: { agent: WorkbenchAgent }) {
  const currentWorkspaceId = useSettingsWorkspaceId();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const [saving, setSaving] = useState(false);
  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const models = useFleetModelCatalog().models.filter((m) => fleetAgentForModel(m.id) === agent);
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
  const sidebarOrder = useWorkspaceStore((s) => s.sidebarOrder);
  const setSidebarOrder = useWorkspaceStore((s) => s.setSidebarOrder);

  return (
    <SettingsPage title="Sessions" description="Choose defaults and archive rules for sessions.">
      <SpaceSettingsNote />
      <SettingsSection title="Sidebar">
        <SettingRow
          label="Session order"
          description="Active sessions need attention, work now, or have an open pull request. In a space, a session that a teammate has open is also active. This device uses this order in Personal and in every space."
        >
          <SettingsSelect
            value={sidebarOrder}
            onChange={(event) => setSidebarOrder(event.target.value as SidebarOrder)}
            aria-label="Sidebar session order"
          >
            <option value="active_first">Active sessions first</option>
            <option value="repository">Group by repository</option>
          </SettingsSelect>
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Defaults">
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
      </SettingsSection>
      <SettingsSection title="Branches">
        <BranchPrefixRow />
      </SettingsSection>
      <ClaudeCoAuthorshipSection />
      <LimitResumeSection />
      <AutoArchiveSection />
    </SettingsPage>
  );
}
