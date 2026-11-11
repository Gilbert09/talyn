import { useEffect, useState } from 'react';
import type { SlackChannelsResponse, SlackStatus, WorkflowAction, WorkflowConditions } from '@talyn/shared';
import { FLEET_MODELS } from '@talyn/shared';
import { api } from '../../../lib/api';
import { captureAnalyticsException } from '../../../lib/analytics';
import { useFleetModelCatalog } from '../../../lib/fleetModelCatalog';
import { startSlackInstall } from '../../../lib/slackInstall';
import { useWorkspaceStore } from '../../../stores/workspace';
import { toast } from '../../../stores/toast';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Select } from '../../ui/select';
import { Textarea } from '../../ui/textarea';
import { TokenField } from './workflowFields';

export function useSlackRuleSettings(teamId: string | undefined, enabled: boolean) {
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [channels, setChannels] = useState<SlackChannelsResponse | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void api.slack.getStatus().then((value) => { if (active) setStatus(value); }).catch(() => {});
    return () => { active = false; };
  }, [enabled]);
  useEffect(() => {
    if (!enabled || !teamId) { setChannels(null); return; }
    let active = true;
    setChannels(null);
    void api.slack.listChannels(teamId).then((value) => { if (active) setChannels(value); }).catch(() => {});
    return () => { active = false; };
  }, [teamId, enabled]);
  const install = status?.installations.find((item) => item.teamId === teamId);
  return { status, channels, install };
}

export function SlackConditions({ conditions, onChange, settings }: {
  conditions: WorkflowConditions;
  onChange: (next: WorkflowConditions) => void;
  settings: ReturnType<typeof useSlackRuleSettings>;
}) {
  const set = (next: Partial<WorkflowConditions>) => onChange({ ...conditions, ...next });
  const { status, channels, install } = settings;
  const authorKind = conditions.slackAuthors?.kind ?? 'linked';
  return <div className="space-y-4">
    <label className="block text-xs font-medium text-muted-foreground">Slack workspace
      <Select className="mt-1 block" value={conditions.slackTeamId ?? ''} onChange={(e) => onChange({ ...conditions, slackTeamId: e.target.value, channels: [] })}>
        <option value="">Pick a Slack workspace</option>
        {status?.installations.map((item) => <option key={item.teamId} value={item.teamId}>{item.teamName ?? item.teamId}</option>)}
      </Select>
    </label>
    <div>
      <span className="text-xs font-medium text-muted-foreground">Channels</span>
      <div className="mt-1 flex flex-wrap gap-2">
        {channels?.channels.map((channel) => <label key={channel.id} className="text-sm">
          <input type="checkbox" checked={(conditions.channels ?? []).includes(channel.id)} onChange={(e) => set({ channels: e.target.checked ? [...(conditions.channels ?? []), channel.id] : (conditions.channels ?? []).filter((id) => id !== channel.id) })} /> #{channel.name}{channel.isPrivate ? ' (private)' : ''}
        </label>)}
      </div>
      <p className="text-xs text-muted-foreground">Only channels Talyn is in are listed. Invite it with /invite @{install?.botName ?? 'Talyn'}.</p>
      {channels?.needsScope && <p className="text-xs text-amber-500">Reinstall Slack to list channels.</p>}
    </div>
    <label className="block text-xs font-medium text-muted-foreground">Who can trigger it
      <Select className="mt-1 block" value={authorKind} onChange={(e) => set({ slackAuthors: e.target.value === 'users' ? { kind: 'users', userIds: [] } : { kind: e.target.value as 'linked' | 'any' } })}>
        <option value="linked">People linked to Talyn</option>
        <option value="any">Anyone in the channel</option>
        <option value="users">Only these people</option>
      </Select>
    </label>
    {conditions.slackAuthors?.kind === 'users' && <TokenField label="Slack user IDs" values={conditions.slackAuthors.userIds} suggestions={[]} placeholder="U123456" onChange={(userIds) => set({ slackAuthors: { kind: 'users', userIds } })} />}
    <TokenField label="Text contains" values={conditions.textContains ? [conditions.textContains] : []} suggestions={[]} placeholder="Text to match" onChange={(values) => set({ textContains: values.at(-1) ?? '' })} />
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={conditions.includeThreadReplies === true} onChange={(e) => set({ includeThreadReplies: e.target.checked })} />Include thread replies</label>
  </div>;
}

export function StartSessionInput({ action, onChange, integration }: {
  action: Extract<WorkflowAction, { type: 'start_session' }>;
  onChange: (next: WorkflowAction) => void;
  integration: 'github' | 'slack';
}) {
  const repositories = useWorkspaceStore((s) => s.repositories);
  useFleetModelCatalog();
  return <div className="space-y-3">
    {integration === 'slack' && <label className="block text-xs font-medium text-muted-foreground">Repository
      <Select className="mt-1 block" value={action.repositoryId ?? ''} onChange={(e) => onChange({ ...action, repositoryId: e.target.value || null })}>
        <option value="">Let Talyn choose</option>
        {repositories.map((repo) => <option key={repo.id} value={repo.id}>{repo.fullName}</option>)}
      </Select>
    </label>}
    <label className="block text-xs font-medium text-muted-foreground">Prompt
      <Textarea className="mt-1" rows={4} value={action.prompt} onChange={(e) => onChange({ ...action, prompt: e.target.value })} />
    </label>
    <label className="block text-xs font-medium text-muted-foreground">Model
      <Select className="mt-1 block" value={action.model ?? ''} onChange={(e) => onChange({ ...action, model: e.target.value || undefined })}>
        <option value="">Workspace default</option>
        {action.model && !FLEET_MODELS.some((model) => model.id === action.model) && <option value={action.model}>{action.model}</option>}
        {FLEET_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
      </Select>
    </label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={action.internetAccess === true} onChange={(e) => onChange({ ...action, internetAccess: e.target.checked })} />Internet access</label>
  </div>;
}

export function SlackActionInput({ action, onChange }: {
  action: Extract<WorkflowAction, { type: 'slack_reply' | 'slack_react' }>;
  onChange: (next: WorkflowAction) => void;
}) {
  if (action.type === 'slack_reply') return <label className="block text-xs font-medium text-muted-foreground">Reply text
    <Textarea className="mt-1" rows={3} value={action.text} placeholder="{{session.url}} or {{message.permalink}}" onChange={(e) => onChange({ ...action, text: e.target.value })} />
  </label>;
  return <label className="block text-xs font-medium text-muted-foreground">Emoji
    <Input className="mt-1" value={action.emoji} placeholder="eyes" onChange={(e) => onChange({ ...action, emoji: e.target.value })} />
  </label>;
}

export function SlackReplyNotice() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const reinstall = async () => {
    try {
      await startSlackInstall(workspaceId);
    } catch (error) {
      captureAnalyticsException(error, { flow: 'slack_connect' });
      toast.error('Could not start Slack sign-in', error instanceof Error ? error.message : 'Try again.');
    }
  };
  return <div className="flex items-center gap-2 text-sm text-amber-500">
    Reinstall Slack to let Talyn reply
    <Button size="sm" variant="outline" onClick={() => void reinstall()}>Reinstall Slack</Button>
  </div>;
}
