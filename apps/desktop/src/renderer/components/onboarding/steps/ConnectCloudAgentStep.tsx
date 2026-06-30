import React, { useState } from 'react';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { api, type PostHogCodeStatus } from '../../../lib/api';
import { ProviderIcon } from '../../../lib/providerMeta';
import type { CloudProviderType } from '@talyn/shared';

interface ConnectCloudAgentStepProps {
  workspaceId: string;
}

type SelectableProvider = Extract<CloudProviderType, 'posthog_code' | 'claude_code'>;

const PROVIDERS: { type: SelectableProvider; label: string }[] = [
  { type: 'posthog_code', label: 'PostHog Code' },
  { type: 'claude_code', label: 'Claude Code' },
];

/**
 * Final (optional) onboarding step — connect a cloud coding agent so Talyn can
 * delegate fix/respond/review work. The user first picks a provider (PostHog Code
 * or Claude Code), then fills in just that provider's inputs — keeping the step
 * compact rather than stacking every provider's form. Skippable (PR tracking works
 * without one); the backend auto-provisions that provider's env marker on save.
 */
export function ConnectCloudAgentStep({ workspaceId }: ConnectCloudAgentStepProps) {
  const [selected, setSelected] = useState<SelectableProvider | null>(null);
  const [connected, setConnected] = useState<Record<SelectableProvider, boolean>>({
    posthog_code: false,
    claude_code: false,
  });

  function markConnected(type: SelectableProvider) {
    setConnected((c) => ({ ...c, [type]: true }));
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Optionally connect a cloud coding agent so you can hand off PR work — fixes, review
        responses, and reviews run on the provider's sandbox and open a PR. Pick a provider to
        connect; you can connect the other (or change this) later in Settings.
      </p>

      <div className="grid grid-cols-2 gap-3">
        {PROVIDERS.map(({ type, label }) => {
          const isSelected = selected === type;
          return (
            <button
              key={type}
              type="button"
              onClick={() => setSelected(type)}
              className={cn(
                'flex items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors',
                isSelected ? 'border-primary ring-1 ring-primary' : 'hover:border-muted-foreground/40'
              )}
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary">
                <ProviderIcon provider={type} className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{label}</div>
                {connected[type] ? (
                  <span className="flex items-center gap-1 text-xs text-green-600">
                    <Check className="h-3 w-3" />
                    Connected
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">Not connected</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {selected === 'posthog_code' && (
        <PostHogForm
          workspaceId={workspaceId}
          connected={connected.posthog_code}
          onConnected={() => markConnected('posthog_code')}
        />
      )}
      {selected === 'claude_code' && (
        <ClaudeForm
          workspaceId={workspaceId}
          connected={connected.claude_code}
          onConnected={() => markConnected('claude_code')}
        />
      )}
    </div>
  );
}

function PostHogForm({
  workspaceId,
  connected,
  onConnected,
}: {
  workspaceId: string;
  connected: boolean;
  onConnected: () => void;
}) {
  const [status, setStatus] = useState<PostHogCodeStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [projectId, setProjectId] = useState('');
  const [host, setHost] = useState('https://us.posthog.com');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!apiKey.trim() || !projectId.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const s = await api.posthog.saveConfig(workspaceId, {
        apiKey: apiKey.trim(),
        projectId: projectId.trim(),
        host: host.trim() || undefined,
      });
      setStatus(s);
      setApiKey('');
      if (s.connected) onConnected();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save credentials');
    } finally {
      setSaving(false);
    }
  }

  if (connected) {
    return (
      <div className="rounded-lg border bg-card p-4">
        <p className="text-sm text-muted-foreground">
          Cloud tasks run under project {status?.projectId} on {status?.host}.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <Input
        label="Personal API key"
        type="password"
        placeholder="phx_..."
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        disabled={saving}
      />
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Project (team) id"
          placeholder="e.g. 2"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          disabled={saving}
        />
        <Input
          label="Host"
          placeholder="https://us.posthog.com"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          disabled={saving}
        />
      </div>
      {error && (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </p>
      )}
      <Button size="sm" onClick={handleSave} disabled={saving || !apiKey.trim() || !projectId.trim()}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save & verify'}
      </Button>
    </div>
  );
}

function ClaudeForm({
  workspaceId,
  connected,
  onConnected,
}: {
  workspaceId: string;
  connected: boolean;
  onConnected: () => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!apiKey.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { connected: ok } = await api.cloudProviders.saveConfig('claude_code', workspaceId, {
        anthropicApiKey: apiKey.trim(),
      });
      setApiKey('');
      if (ok) onConnected();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save credentials');
    } finally {
      setSaving(false);
    }
  }

  if (connected) {
    return (
      <div className="rounded-lg border bg-card p-4">
        <p className="text-sm text-muted-foreground">
          Cloud tasks run on Claude Managed Agents (Sonnet by default — change the model in
          Settings) and open PRs via this workspace's GitHub connection.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <p className="text-sm text-muted-foreground">
        Add an Anthropic API key. GitHub access reuses this workspace's GitHub connection.
      </p>
      <Input
        label="Anthropic API key"
        type="password"
        placeholder="sk-ant-..."
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        disabled={saving}
      />
      {error && (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </p>
      )}
      <Button size="sm" onClick={handleSave} disabled={saving || !apiKey.trim()}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save & verify'}
      </Button>
    </div>
  );
}
