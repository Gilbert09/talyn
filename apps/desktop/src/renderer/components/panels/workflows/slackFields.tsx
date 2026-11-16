import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Check, Loader2, Lock, Plus, X } from 'lucide-react';
import type { SlackChannelsResponse, SlackChannelSummary, SlackStatus, WorkflowAction, WorkflowConditions, WorkflowIntegration } from '@talyn/shared';
import { FLEET_MODELS } from '@talyn/shared';
import { api } from '../../../lib/api';
import { cn } from '../../../lib/utils';
import { captureAnalyticsException } from '../../../lib/analytics';
import { useFleetModelCatalog } from '../../../lib/fleetModelCatalog';
import { startSlackInstall } from '../../../lib/slackInstall';
import { useWorkspaceStore } from '../../../stores/workspace';
import { toast } from '../../../stores/toast';
import { Button } from '../../ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../../ui/command';
import { Input } from '../../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { Select } from '../../ui/select';
import { Textarea } from '../../ui/textarea';
import { TokenField } from './workflowFields';

export type SlackChannelsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: SlackChannelsResponse };

export function useSlackRuleSettings(teamId: string | undefined, enabled: boolean) {
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [channelsState, setChannelsState] = useState<SlackChannelsState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void api.slack.getStatus().then((value) => { if (active) setStatus(value); }).catch((error) => {
      captureAnalyticsException(error, { flow: 'slack_status' });
    });
    return () => { active = false; };
  }, [enabled]);
  useEffect(() => {
    if (!enabled || !teamId) return;
    let active = true;
    setChannelsState({ status: 'loading' });
    void api.slack.listChannels(teamId).then((data) => {
      if (active) setChannelsState({ status: 'ready', data });
    }).catch((error) => {
      captureAnalyticsException(error, { flow: 'slack_channels' });
      if (active) setChannelsState({ status: 'error', message: error instanceof Error ? error.message : 'Try again.' });
    });
    return () => { active = false; };
  }, [teamId, enabled, attempt]);
  const refreshChannels = useCallback(() => setAttempt((n) => n + 1), []);
  const install = status?.installations.find((item) => item.teamId === teamId);
  return { status, channelsState, refreshChannels, install };
}

function SlackReinstallButton({ children }: { children: ReactNode }) {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const reinstall = async () => {
    try {
      await startSlackInstall(workspaceId);
    } catch (error) {
      captureAnalyticsException(error, { flow: 'slack_connect' });
      toast.error('Could not start Slack sign-in', error instanceof Error ? error.message : 'Try again.');
    }
  };
  return <Button size="sm" variant="outline" onClick={() => void reinstall()}>{children}</Button>;
}

function ChannelLabel({ channel }: { channel: SlackChannelSummary }) {
  return <span className="inline-flex items-center gap-1">
    #{channel.name}
    {channel.isPrivate && <><Lock className="h-3 w-3" aria-hidden="true" /><span className="sr-only">(private)</span></>}
  </span>;
}

export function SlackChannelPicker({ value, onChange, state, onRefresh, hasTeam, botName }: {
  value: string[];
  onChange: (next: string[]) => void;
  state: SlackChannelsState;
  onRefresh: () => void;
  hasTeam: boolean;
  botName: string;
}) {
  const [open, setOpen] = useState(false);
  const channels = state.status === 'ready' ? state.data.channels : [];
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  let body: ReactNode;
  if (!hasTeam) {
    body = <p className="text-xs text-muted-foreground">Pick a Slack workspace first.</p>;
  } else if (state.status === 'loading') {
    body = <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Loading channels...
    </p>;
  } else if (state.status === 'error') {
    body = <div className="flex flex-wrap items-center gap-2 text-xs text-red-500" role="alert">
      <span>Could not load channels. {state.message}</span>
      <Button size="sm" variant="outline" onClick={onRefresh}>Try again</Button>
    </div>;
  } else if (state.data.needsScope) {
    body = <div className="flex flex-wrap items-center gap-2 text-xs text-amber-500">
      Reinstall Slack so Talyn can list channels
      <SlackReinstallButton>Reinstall Slack</SlackReinstallButton>
    </div>;
  } else if (channels.length === 0) {
    body = <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>Talyn isn&apos;t in any channels yet. In Slack, open a channel and run /invite @{botName}, then refresh.</span>
      <Button size="sm" variant="outline" onClick={onRefresh}>Refresh</Button>
    </div>;
  } else {
    body = <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" aria-label="Add channels">
          <Plus className="mr-1 h-3.5 w-3.5" />Add channels
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Search channels" />
          <CommandList>
            <CommandEmpty>No channels match.</CommandEmpty>
            <CommandGroup>
              {channels.map((channel) => <CommandItem key={channel.id} value={`${channel.name} ${channel.id}`} onSelect={() => toggle(channel.id)}>
                <Check className={cn('h-3.5 w-3.5', value.includes(channel.id) ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                <ChannelLabel channel={channel} />
              </CommandItem>)}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>;
  }

  return <div className="space-y-2">
    <span className="text-xs font-medium text-muted-foreground">Channels</span>
    {value.length > 0 && <ul className="flex flex-wrap gap-1.5" aria-label="Selected channels">
      {value.map((id) => {
        const channel = byId.get(id);
        return <li key={id} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs">
          {channel ? <ChannelLabel channel={channel} /> : <span>{id}</span>}
          <button type="button" className="rounded-full text-muted-foreground hover:text-foreground" aria-label={`Remove ${channel ? `#${channel.name}` : id}`} onClick={() => toggle(id)}>
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </li>;
      })}
    </ul>}
    <div>{body}</div>
    <p className="text-xs text-muted-foreground">
      Only channels Talyn is in are listed. Invite it with /invite @{botName}.
      {hasTeam && state.status !== 'loading' && <> <button type="button" className="underline hover:text-foreground" onClick={onRefresh}>Refresh</button></>}
    </p>
  </div>;
}

export function SlackConditions({ conditions, onChange, settings }: {
  conditions: WorkflowConditions;
  onChange: (next: WorkflowConditions) => void;
  settings: ReturnType<typeof useSlackRuleSettings>;
}) {
  const set = (next: Partial<WorkflowConditions>) => onChange({ ...conditions, ...next });
  const { status, channelsState, refreshChannels, install } = settings;
  return <div className="space-y-4">
    <label className="block text-xs font-medium text-muted-foreground">Slack workspace
      <Select className="mt-1 block" value={conditions.slackTeamId ?? ''} onChange={(e) => onChange({ ...conditions, slackTeamId: e.target.value, channels: [] })}>
        <option value="">Pick a Slack workspace</option>
        {status?.installations.map((item) => <option key={item.teamId} value={item.teamId}>{item.teamName ?? item.teamId}</option>)}
      </Select>
    </label>
    <SlackChannelPicker
      value={conditions.channels ?? []}
      onChange={(next) => set({ channels: next })}
      state={channelsState}
      onRefresh={refreshChannels}
      hasTeam={Boolean(conditions.slackTeamId)}
      botName={install?.botName ?? 'Talyn'}
    />
    <TokenField label="Text contains" values={conditions.textContains ? [conditions.textContains] : []} suggestions={[]} placeholder="Text to match" onChange={(values) => set({ textContains: values.at(-1) ?? '' })} />
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={conditions.includeThreadReplies === true} onChange={(e) => set({ includeThreadReplies: e.target.checked })} />Include thread replies</label>
  </div>;
}

/**
 * Edits `start_session`, and `start_task` on a webhook or issue rule. A webhook
 * or Linear rule must name its repository. A GitHub Issues rule can use the
 * issue's own repository. A PostHog Inbox rule always uses the report's
 * repository, so it shows no repository picker.
 */
export function StartSessionInput({ action, onChange, integration }: {
  action: Extract<WorkflowAction, { type: 'start_session' | 'start_task' }>;
  onChange: (next: WorkflowAction) => void;
  integration: WorkflowIntegration;
}) {
  const repositories = useWorkspaceStore((s) => s.repositories);
  useFleetModelCatalog();
  const repositoryRequired = integration === 'webhook' || integration === 'linear'
    || (action.type === 'start_task' && integration !== 'github_issues');
  const setRepository = (value: string) => onChange(action.type === 'start_task' && repositoryRequired
    ? { ...action, repositoryId: value }
    : { ...action, repositoryId: value || null });
  const emptyRepository = repositoryRequired
    ? 'Pick a repository'
    : integration === 'github_issues' ? 'The issue\'s repository' : 'Let Talyn choose';
  return <div className="space-y-3">
    {(integration === 'slack' || integration === 'github_issues' || repositoryRequired) && <label className="block text-xs font-medium text-muted-foreground">Repository
      <Select className="mt-1 block" value={action.repositoryId ?? ''} onChange={(e) => setRepository(e.target.value)}>
        <option value="">{emptyRepository}</option>
        {repositories.map((repo) => <option key={repo.id} value={repo.id}>{repo.fullName}</option>)}
      </Select>
    </label>}
    <label className="block text-xs font-medium text-muted-foreground">Prompt
      <Textarea className="mt-1" rows={4} value={action.prompt} onChange={(e) => onChange({ ...action, prompt: e.target.value })} />
    </label>
    {integration === 'webhook' && <p className="text-xs text-muted-foreground">
      Talyn quotes the request body below the prompt as untrusted text. {'{{payload.<path>}}'} quotes one value in the same way.
    </p>}
    {(integration === 'linear' || integration === 'github_issues') && <p className="text-xs text-muted-foreground">
      Talyn adds the issue title, description and link below your prompt as untrusted text.
    </p>}
    {integration === 'posthog_inbox' && <p className="text-xs text-muted-foreground" data-attr="posthog-inbox-repository-hint">
      The session works on the report's own repository. To limit the repositories, add a Repository condition.
    </p>}
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
  return <div className="flex items-center gap-2 text-sm text-amber-500">
    Reinstall Slack to let Talyn reply
    <SlackReinstallButton>Reinstall Slack</SlackReinstallButton>
  </div>;
}
