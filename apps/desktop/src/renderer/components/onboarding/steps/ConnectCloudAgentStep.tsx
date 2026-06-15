import React, { useState } from 'react';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Badge } from '../../ui/badge';
import { api, type PostHogCodeStatus } from '../../../lib/api';
import { ProviderIcon } from '../../../lib/providerMeta';

interface ConnectCloudAgentStepProps {
  workspaceId: string;
}

/**
 * Final (optional) onboarding step — connect a cloud coding agent so FastOwl can
 * delegate fix/respond/review work. Offers either provider: PostHog Code or
 * Claude Code. Skippable (PR tracking works without one); each card saves
 * independently and the backend auto-provisions that provider's env marker.
 */
export function ConnectCloudAgentStep({ workspaceId }: ConnectCloudAgentStepProps) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Optionally connect a cloud coding agent so you can hand off PR work — fixes, review
        responses, and reviews run on the provider's sandbox and open a PR. Connect either one (or
        both); you can change this later in Settings.
      </p>

      <PostHogCard workspaceId={workspaceId} />
      <ClaudeCard workspaceId={workspaceId} />
    </div>
  );
}

function PostHogCard({ workspaceId }: { workspaceId: string }) {
  const [status, setStatus] = useState<PostHogCodeStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [projectId, setProjectId] = useState('');
  const [host, setHost] = useState('https://us.posthog.com');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connected = Boolean(status?.connected);

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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save credentials');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
          <ProviderIcon provider="posthog_code" className="h-5 w-5" />
        </div>
        <div className="flex items-center gap-2">
          <span className="font-medium">PostHog Code</span>
          {connected ? (
            <Badge variant="default" className="bg-green-600">
              <Check className="mr-1 h-3 w-3" />
              Connected
            </Badge>
          ) : (
            <Badge variant="secondary">Not connected</Badge>
          )}
        </div>
      </div>

      {connected ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Cloud tasks run under project {status?.projectId} on {status?.host}.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
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
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || !apiKey.trim() || !projectId.trim()}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save & verify'}
          </Button>
        </div>
      )}
    </div>
  );
}

function ClaudeCard({ workspaceId }: { workspaceId: string }) {
  const [connected, setConnected] = useState(false);
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
      setConnected(ok);
      setApiKey('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save credentials');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
          <ProviderIcon provider="claude_code" className="h-5 w-5" />
        </div>
        <div className="flex items-center gap-2">
          <span className="font-medium">Claude Code</span>
          {connected ? (
            <Badge variant="default" className="bg-green-600">
              <Check className="mr-1 h-3 w-3" />
              Connected
            </Badge>
          ) : (
            <Badge variant="secondary">Not connected</Badge>
          )}
        </div>
      </div>

      {connected ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Cloud tasks run on Claude Managed Agents (Sonnet by default — change the model in
          Settings) and open PRs via this workspace's GitHub connection.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
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
      )}
    </div>
  );
}
