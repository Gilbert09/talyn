import { workbenches, type CloudProviderInfo } from '@talyn/client/native';
import { addableBoxAgent, type Workbench } from '@talyn/shared';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { useMobileRuntime, useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { Button } from '../../components/UI';
import { type, useTheme } from '../../theme/tokens';
import { useResource } from '../../workflow/hooks';

/** Old boxes need a restart before they can use another connected agent. */
export function SandboxAgentNotice({ item }: { item: Workbench }) {
  const { workflow } = useMobileRuntime();
  const workspace = useWorkspace();
  const network = useNetwork();
  const c = useTheme();
  const providers = useResource<CloudProviderInfo[]>('providers');
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (item.status !== 'ready') setRequested(false);
  }, [item.status]);
  const settings = item.settings as Record<string, unknown>;
  const saved = settings?.sandboxAgents as Record<string, string[]> | undefined;
  const agents = (item.sandboxId && saved?.[item.sandboxId]) || [item.agent];
  const owner = workspace.choices.some((choice) => choice.id === item.workspaceId);
  if (!owner || item.kind === 'thread' || item.runtime !== 'sandbox'
    || item.status !== 'ready' || !item.sandboxId || agents.length !== 1) return null;
  const missing = addableBoxAgent(agents, providers.data?.find((p) => p.type === 'selfhosted'));
  if (!missing) return null;

  const restart = async () => {
    setBusy(true);
    setError('');
    try {
      await workbenches.restart(item.id, { reason: 'add connected agents' });
      setRequested(true);
      void workflow.load('workbench', item.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not restart the sandbox.');
    } finally {
      setBusy(false);
    }
  };
  return <View accessibilityLiveRegion="polite">
    <Text style={[type.caption, { color: c.muted }]}>
      This sandbox runs only {missing === 'codex' ? 'Claude' : 'Codex'}. Restart it to add {missing === 'codex' ? 'Codex' : 'Claude'}.
    </Text>
    <Text style={[type.caption, { color: c.muted }]}>
      Your branch and uncommitted changes will transfer. Running processes will stop. Large ignored files may not transfer.
    </Text>
    {requested || settings?.restartRequestedAt
      ? <Text style={[type.caption, { color: c.muted }]}>Restart requested. It will start after all running turns end.</Text>
      : <Button size="sm" variant="quiet" title={busy ? 'Requesting restart…' : 'Restart sandbox'}
        disabled={busy || network !== 'online'} onPress={() => void restart()} />}
    {error ? <Text style={[type.caption, { color: c.destructive }]}>{error}</Text> : null}
  </View>;
}
