import { useState } from 'react';
import { fleetAgentForModel, isStoredFleetModelId, type Workspace } from '@talyn/shared';
import { api } from '../../lib/api';
import { useWorkspaceStore } from '../../stores/workspace';
import { SettingRow, SettingsSelect } from '../ui/settings';

/**
 * Which model a cloud provider's tasks run on. Shown only while that provider
 * is connected. Persists to the given `workspace.settings` key; editable
 * without re-entering credentials — switching just makes the next run use the
 * new model.
 */
export function WorkspaceModelSelector({
  providerType,
  title,
  description,
  models,
  defaultId,
  settingKey,
  className,
}: {
  providerType: 'posthog_code' | 'selfhosted';
  title: string;
  description: string;
  models: ReadonlyArray<{ id: string; label: string }>;
  defaultId: string;
  settingKey: 'posthogCodeModel' | 'fleetModel';
  className?: string;
}) {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const cloudProviders = useWorkspaceStore((s) => s.cloudProviders);
  const [saving, setSaving] = useState(false);

  const connected = (cloudProviders ?? []).some(
    (p) => p.type === providerType && p.connected,
  );
  if (!connected) return null;

  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const current = workspace?.settings?.[settingKey] ?? defaultId;

  const onChange = async (value: string) => {
    if (!currentWorkspaceId) return;
    setSaving(true);
    try {
      // Writing the fleet model also files it under its VENDOR, so the choice
      // survives switching the default agent away and back — and so the
      // per-task "run this on Codex" menu has something to read. `fleetModel`
      // alone holds one model, and there are two agents.
      const settings = {
        [settingKey]: value,
        ...(settingKey === 'fleetModel' && isStoredFleetModelId(value)
          ? {
              fleetModels: {
                ...(workspace?.settings?.fleetModels ?? {}),
                [fleetAgentForModel(value)]: value,
              },
            }
          : {}),
      } as Workspace['settings'];
      await api.workspaces.update(currentWorkspaceId, { settings });
      setWorkspaces(
        workspaces.map((w) =>
          w.id === currentWorkspaceId
            ? { ...w, settings: { ...w.settings, ...settings } as Workspace['settings'] }
            : w,
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow label={title} description={description} className={className}>
      <SettingsSelect
        value={current}
        disabled={saving}
        onChange={(e) => onChange(e.target.value)}
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
