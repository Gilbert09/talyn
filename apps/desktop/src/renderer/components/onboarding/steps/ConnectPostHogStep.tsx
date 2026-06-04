import React, { useState } from 'react';
import { AlertCircle, BarChart3, Check, Loader2 } from 'lucide-react';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Badge } from '../../ui/badge';
import { api, type PostHogCodeStatus } from '../../../lib/api';

interface ConnectPostHogStepProps {
  workspaceId: string;
}

/**
 * Step 4 (optional) — connect a cloud provider so FastOwl can delegate
 * fix/respond/review work. PostHog Code is the only live provider today.
 * Skippable: PR tracking works without it; saving credentials lets the
 * backend auto-provision the cloud environment marker.
 */
export function ConnectPostHogStep({ workspaceId }: ConnectPostHogStepProps) {
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
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Optionally connect a cloud coding agent so you can hand off PR work — fixes,
        review responses, and reviews run on the provider's sandbox and open a PR. You can
        skip this and set it up later in Settings.
      </p>

      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
            <BarChart3 className={connected ? 'h-5 w-5 text-green-500' : 'h-5 w-5'} />
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
    </div>
  );
}
