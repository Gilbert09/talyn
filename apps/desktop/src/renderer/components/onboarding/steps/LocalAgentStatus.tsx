import { useEffect, useState } from 'react';
import { Check, Laptop, Loader2, RefreshCw, X } from 'lucide-react';
import type { WorkbenchLocalReadiness } from '@talyn/shared';
import { getWorkbenchBridge } from '../../../lib/workbenchBridge';
import { Button } from '../../ui/button';

const AGENTS = [
  { key: 'claude', name: 'Claude Code', hint: 'Install with: npm i -g @anthropic-ai/claude-code' },
  { key: 'codex', name: 'Codex', hint: 'Install with: npm i -g @openai/codex' },
] as const;

/**
 * The "Run locally" path: which agent CLIs this machine already has. Renders
 * nothing when the desktop bridge is absent (older main process, tests).
 * `recheck` adds a button that skips main's 30 s readiness cache, for after
 * an install.
 */
export function LocalAgentStatus({ recheck = false }: { recheck?: boolean } = {}) {
  const [local, setLocal] = useState<WorkbenchLocalReadiness | null>(null);
  const [checking, setChecking] = useState(false);
  const bridge = getWorkbenchBridge();

  const runRecheck = async () => {
    if (!bridge) return;
    setChecking(true);
    try {
      setLocal(await bridge.readiness(true));
    } catch {
      // Keep the last answer.
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    if (!bridge) return undefined;
    bridge
      .readiness()
      .then((r) => {
        if (!cancelled) setLocal(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  if (!bridge) return null;

  return (
    <div className="space-y-2 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <Laptop className="h-4 w-4 text-muted-foreground" />
        <p className="font-medium">Run locally</p>
        {recheck && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => void runRecheck()}
            disabled={checking}
          >
            {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Re-check
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Use an agent CLI already installed on this machine. No sign-in needed here.
      </p>
      {local === null ? (
        <p className="text-sm text-muted-foreground">Checking this machine…</p>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {AGENTS.map(({ key, name, hint }) => {
            const found = local[key];
            return (
              <li key={key} className="flex items-start gap-2">
                {found.ok ? (
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                ) : (
                  <X className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0">
                  <span className="font-medium">{name}</span>{' '}
                  {found.ok ? (
                    <span className="break-all font-mono text-xs text-muted-foreground">
                      found at {found.path}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">not found. {hint}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
