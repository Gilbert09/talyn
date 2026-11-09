import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Laptop, Loader2, Unplug } from 'lucide-react';
import type { McpToken } from '@talyn/shared';
import type { LocalAgentKitStatus } from '../../../../main/localAgentKit';
import { api } from '../../../lib/api';
import {
  AGENT_LABEL,
  agentsToConnect,
  connectedAgents,
  describeAgent,
  localTokenName,
  tokensToRevoke,
} from '../../../lib/localAgents';
import { cn } from '../../../lib/utils';
import { toast } from '../../../stores/toast';
import { Button } from '../../ui/button';
import { Card } from '../../ui/card';

interface LocalAgentsCardProps {
  endpoint: string;
  /** The token list of the page, null while it loads. */
  tokens: McpToken[] | null;
  /** Reload the page's token list after this card mints or revokes one. */
  reloadTokens: () => Promise<void>;
}

/**
 * One click connects Claude Code and Codex on this computer to Talyn: it
 * mints a token, then the main process writes the `talyn` MCP server and the
 * local skill pack into both agents' config (see main/localAgentKit.ts).
 * Reconnect mints a new token and revokes the one it replaces.
 */
export function LocalAgentsCard({ endpoint, tokens, reloadTokens }: LocalAgentsCardProps) {
  const [status, setStatus] = useState<LocalAgentKitStatus | null>(null);
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.electron.localAgents.status());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the local agent config');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const revoke = async (list: McpToken[]) => {
    await Promise.all(list.map((t) => api.mcpTokens.revoke(t.id).catch(() => undefined)));
  };

  const handleConnect = async () => {
    if (!status) return;
    setBusy('connect');
    setError(null);
    try {
      const minted = await api.mcpTokens.create({ name: localTokenName(status.hostname) });
      let after: LocalAgentKitStatus;
      try {
        after = await window.electron.localAgents.install({
          endpoint,
          token: minted.token,
          agents: agentsToConnect(status),
        });
      } catch (e) {
        await revoke([minted.token_meta]);
        throw e;
      }
      await revoke(tokensToRevoke(tokens ?? [], status, after, minted.token_meta));
      setStatus(after);
      await reloadTokens();
      if (after.errors && after.errors.length > 0) {
        setError(after.errors.join(' '));
      } else {
        toast.success('Connected. Restart Claude Code and Codex to load Talyn.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect');
    } finally {
      setBusy(null);
    }
  };

  const handleDisconnect = async () => {
    if (!status) return;
    setBusy('disconnect');
    setError(null);
    try {
      const after = await window.electron.localAgents.remove(connectedAgents(status));
      await revoke(tokensToRevoke(tokens ?? [], status, after));
      setStatus(after);
      await reloadTokens();
      if (after.errors && after.errors.length > 0) setError(after.errors.join(' '));
      else toast.success('Disconnected Claude Code and Codex from Talyn');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not disconnect');
    } finally {
      setBusy(null);
    }
  };

  const anyConnected = status ? connectedAgents(status).length > 0 : false;

  return (
    <Card className="p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Laptop className="w-3.5 h-3.5" />
        <span className="text-[13px] font-medium">Connect this computer</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Add the Talyn MCP server and Talyn&apos;s skills to Claude Code and Codex on this
        computer. Then your local agent can start cloud sessions, follow them, bring their
        branches here and look after your pull requests.
      </p>

      {status === null ? (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking this computer…
        </p>
      ) : (
        <>
          <div className="divide-y rounded-md border">
            {status.agents.map((state) => {
              const summary = describeAgent(state, endpoint, tokens);
              return (
                <div key={state.agent} className="flex items-center gap-3 px-2.5 py-2">
                  <span className="w-24 shrink-0 text-[13px] font-medium">
                    {AGENT_LABEL[state.agent]}
                  </span>
                  <span
                    className={cn(
                      'flex-1 min-w-0 text-xs',
                      summary.tone === 'ok' && 'text-green-700 dark:text-green-400',
                      summary.tone === 'warn' && 'text-amber-600 dark:text-amber-400',
                      summary.tone === 'muted' && 'text-muted-foreground'
                    )}
                  >
                    {summary.text}
                    {state.blockedSkills.length > 0 && (
                      <span className="block text-muted-foreground">
                        Your own {state.blockedSkills.join(', ')} skill stays. Talyn did not
                        replace it.
                      </span>
                    )}
                  </span>
                  {state.skills.length > 0 && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {state.skills.length} skills
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-1">
            {status.pack.map((name) => (
              <code
                key={name}
                className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
              >
                {name}
              </code>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void handleConnect()} disabled={busy !== null}>
              {busy === 'connect' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {anyConnected ? 'Reconnect' : 'Connect Claude Code and Codex'}
            </Button>
            {anyConnected && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void handleDisconnect()}
                disabled={busy !== null}
              >
                {busy === 'disconnect' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Unplug className="w-3.5 h-3.5" />
                )}
                Disconnect
              </Button>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Talyn writes <code>~/.claude.json</code>, <code>~/.codex/config.toml</code> and
            the skills folders. It keeps everything else in those files. Restart open Claude
            Code and Codex sessions after you connect.
          </p>
        </>
      )}

      {error && (
        <p className="text-xs text-destructive flex items-center gap-1">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {error}
        </p>
      )}
    </Card>
  );
}
