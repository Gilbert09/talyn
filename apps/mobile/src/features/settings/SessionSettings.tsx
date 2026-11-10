import { workspaces } from '@talyn/client/native';
import {
  defaultFleetModelForAgent, fleetAgentForModel, storedFleetModelForAgent,
  type Workspace, type WorkspaceSettings, type WorkbenchAgent,
} from '@talyn/shared';
import { useState } from 'react';
import { Alert } from 'react-native';

import { AppText, Group, Row, Toggle, type SheetRequest } from '../../components/UI';
import { errorMessage } from '../../lib/errors';
import { useFleetModelCatalog } from '../../lib/fleetModelCatalog';
import { modelLabel } from '../../lib/models';
import { Fact } from '../more/Page';
import { branchPrefixLine, idleDayChoices, idleDaysLabel, sessionSettingsOf } from './model';

const AGENTS: ReadonlyArray<{ agent: WorkbenchAgent; label: string }> = [{ agent: 'claude', label: 'Claude' }, { agent: 'codex', label: 'Codex' }];

/**
 * The workspace's session settings, through the same `workspaces.update` web
 * uses. Models, auto-archive and limit resume can change here. Branch prefix
 * and co-author show read-only. Mirrors web Settings → Sessions.
 */
export function SessionSettings({ workspace, refresh, offline, openSheet }: {
  workspace: Workspace; refresh(): Promise<void>; offline: boolean; openSheet(request: SheetRequest): void;
}) {
  const [pending, setPending] = useState<Partial<WorkspaceSettings>>({});
  const [saving, setSaving] = useState(false);
  const { models: fleetModels } = useFleetModelCatalog();
  const settings = { ...workspace.settings, ...pending } as WorkspaceSettings;
  const view = sessionSettingsOf(settings);
  const disabled = saving || offline;

  const save = async (patch: Partial<WorkspaceSettings>, failure: string) => {
    setPending((prev) => ({ ...prev, ...patch }));
    setSaving(true);
    try {
      await workspaces.update(workspace.id, { settings: patch as WorkspaceSettings });
      await refresh();
    } catch (error) {
      Alert.alert(failure, errorMessage(error, 'Please try again.'));
    } finally {
      setPending({});
      setSaving(false);
    }
  };

  const pickModel = (agent: WorkbenchAgent, label: string) => {
    const current = storedFleetModelForAgent(settings, agent) ?? defaultFleetModelForAgent(agent);
    openSheet({ title: `${label} model`, message: `The ${label} model new sessions start with.`,
      actions: fleetModels.filter((model) => fleetAgentForModel(model.id) === agent).map((model) => ({
        label: model.label, selected: model.id === current,
        onPress: () => { void save({ fleetModels: { ...(settings.fleetModels ?? {}), [agent]: model.id } } as Partial<WorkspaceSettings>, 'Could not save the model'); },
      })) });
  };

  const pickIdleDays = () => openSheet({ title: 'Archive idle sessions',
    message: 'A session with no messages, terminal input or scripts for this long is archived. Its work is saved first.',
    actions: idleDayChoices(view.idleDays).map((days) => ({ label: idleDaysLabel(days), selected: days === view.idleDays,
      onPress: () => { void save({ autoArchiveIdleDays: days }, 'Could not save auto-archive settings'); } })) });

  return <>
    <Group title="Sessions" footer="Sessions in this workspace use these settings.">
      {AGENTS.map(({ agent, label }) => <Row key={agent} title={`${label} model`} chevron disabled={disabled}
        accessibilityLabel={`${label} model. ${modelLabel(storedFleetModelForAgent(settings, agent), agent)}.`}
        trailing={<AppText variant="meta" tone="muted">{modelLabel(storedFleetModelForAgent(settings, agent), agent)}</AppText>}
        onPress={() => pickModel(agent, label)} />)}
      <Row title="Continue when an agent hits its limit" titleLines={3}
        subtitle={<AppText variant="meta" tone="muted">Move the chat to your other agent, or wait for the limit to reset and continue.</AppText>}
        trailing={<Toggle accessibilityLabel="Continue when an agent hits its limit" value={view.continueOnLimit} disabled={disabled}
          onValueChange={(value) => { void save({ autoResumeOnLimit: value }, 'Could not save the setting'); }} />} />
      <Row title="Archive idle sessions" chevron disabled={disabled} onPress={pickIdleDays}
        accessibilityLabel={`Archive idle sessions. ${idleDaysLabel(view.idleDays)}.`}
        trailing={<AppText variant="meta" tone="muted">{idleDaysLabel(view.idleDays)}</AppText>} />
      <Row title="Archive when the pull request merges" titleLines={3} divider={false}
        trailing={<Toggle accessibilityLabel="Archive when the pull request merges" value={view.archiveOnMerge} disabled={disabled}
          onValueChange={(value) => { void save({ autoArchiveOnMerge: value }, 'Could not save auto-archive settings'); }} />} />
    </Group>
    <Group title="Branches and commits" footer={`${branchPrefixLine(view.branchPrefix)}. Change these in Talyn on the web.`}>
      <Fact label="Branch prefix" value={view.branchPrefix || 'None'} />
      <Fact label="Add Claude as a co-author" value={view.claudeCoAuthor ? 'On' : 'Off'} divider={false} />
    </Group>
  </>;
}
