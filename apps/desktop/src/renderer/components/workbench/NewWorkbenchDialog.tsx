import { useEffect, useMemo, useState } from 'react';
import { Cloud, FolderOpen, Laptop, Loader2 } from 'lucide-react';
import {
  cloudAgentChoices,
  defaultFleetModelForAgent,
  storedFleetModelForAgent,
  type Workbench,
  type WorkbenchAgent,
  type WorkbenchRuntimeKind,
} from '@talyn/shared';
import { cn } from '../../lib/utils';
import { api } from '../../lib/api';
import { getWorkbenchBridge } from '../../lib/workbenchBridge';
import { createLocalWorkbench } from '../../lib/localWorkbench';
import { opsFor } from '../../lib/workbenchOps';
import { toast } from '../../stores/toast';
import { useWorkspaceStore } from '../../stores/workspace';
import { usePullRequestStore } from '../../stores/pullRequests';
import { useWorkbenchStore } from '../../stores/workbenches';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Select } from '../ui/select';
import { Textarea } from '../ui/textarea';
import { ModelPicker } from './ComposerControls';

const AGENT_LABEL: Record<WorkbenchAgent, string> = { claude: 'Claude Code', codex: 'Codex' };

export function NewWorkbenchDialog() {
  const { open, prefill } = useWorkbenchStore((s) => s.newDialog);
  const close = useWorkbenchStore((s) => s.closeNewDialog);
  if (!open) return null;
  return <NewWorkbenchForm key={prefill?.fromPullRequestId ?? 'new'} onClose={close} prefill={prefill} />;
}

function NewWorkbenchForm({
  onClose,
  prefill,
}: {
  onClose: () => void;
  prefill: ReturnType<typeof useWorkbenchStore.getState>['newDialog']['prefill'];
}) {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.currentWorkspaceId) ?? null);
  const repositories = useWorkspaceStore((s) => s.repositories);
  const cloudProviders = useWorkspaceStore((s) => s.cloudProviders);
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const prRows = usePullRequestStore((s) => s.rows);
  const workbenchMap = useWorkbenchStore((s) => s.workbenches);
  const bridge = getWorkbenchBridge();

  const [fromPr, setFromPr] = useState(Boolean(prefill?.fromPullRequestId));
  const [prId, setPrId] = useState(prefill?.fromPullRequestId ?? '');
  const [repositoryId, setRepositoryId] = useState(prefill?.repositoryId ?? repositories[0]?.id ?? '');
  const [baseBranch, setBaseBranch] = useState(prefill?.baseBranch ?? '');
  const [runtime, setRuntime] = useState<WorkbenchRuntimeKind>('sandbox');
  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [localAgents, setLocalAgents] = useState<{ claude: string | null; codex: string | null } | null>(null);
  const [agent, setAgent] = useState<WorkbenchAgent | null>(null);
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repo = repositories.find((r) => r.id === repositoryId) ?? null;
  const defaultBranch = workspace?.repos.find((r) => r.name === repo?.fullName)?.defaultBranch ?? '';
  const openPrs = useMemo(
    () => prRows.filter((r) => r.state === 'open' && (!repositoryId || r.repositoryId === repositoryId)),
    [prRows, repositoryId]
  );
  const pr = fromPr ? (prRows.find((r) => r.id === prId) ?? null) : null;

  const sandboxAgents = useMemo(
    () =>
      cloudAgentChoices(cloudProviders, workspace?.settings)
        .filter((c) => c.type === 'selfhosted' && c.agent)
        .map((c) => c.agent as WorkbenchAgent),
    [cloudProviders, workspace?.settings]
  );
  const agents: WorkbenchAgent[] = useMemo(
    () => (runtime === 'sandbox' ? sandboxAgents : (['claude', 'codex'] as const).filter((a) => Boolean(localAgents?.[a]))),
    [runtime, sandboxAgents, localAgents]
  );

  useEffect(() => {
    if (runtime === 'local' && bridge && !localAgents) {
      bridge.detectAgents().then(setLocalAgents).catch(() => setLocalAgents({ claude: null, codex: null }));
    }
  }, [runtime, bridge, localAgents]);

  // Keep the agent valid for the runtime, and the model valid for the agent.
  useEffect(() => {
    if (agent && agents.includes(agent)) return;
    setAgent(agents[0] ?? null);
  }, [agents, agent]);
  useEffect(() => {
    if (agent) setModel(storedFleetModelForAgent(workspace?.settings, agent) ?? defaultFleetModelForAgent(agent));
  }, [agent, workspace?.settings]);

  useEffect(() => {
    if (pr) {
      setRepositoryId(pr.repositoryId);
      setBaseBranch(pr.summary.baseBranch);
    }
  }, [pr]);

  const pickFolder = async () => {
    if (!bridge) return;
    const path = await bridge.pickRepoFolder();
    if (path) setRepoPath(path);
  };

  const submit = async () => {
    if (!workspaceId || !repo || !agent) return;
    if (fromPr && !pr) return setError('Pick a pull request.');
    setBusy(true);
    setError(null);
    try {
      let wb: Workbench;
      if (runtime === 'sandbox') {
        wb = await api.workbenches.create({
          workspaceId,
          repositoryId: repo.id,
          runtime: 'sandbox',
          agent,
          model,
          baseBranch: baseBranch.trim() || undefined,
          fromPullRequestId: pr?.id,
          prompt: prompt.trim() || undefined,
        });
      } else {
        wb = await createLocalWorkbench({
          workspaceId,
          repositoryId: repo.id,
          repoFullName: repo.fullName,
          agent,
          model,
          baseBranch: baseBranch.trim() || defaultBranch || undefined,
          branch: pr?.summary.headBranch,
          fromPullRequestId: pr?.id,
          repoPath: repoPath ?? undefined,
          takenNames: Object.values(workbenchMap).map((w) => w.name),
        });
      }
      const store = useWorkbenchStore.getState();
      store.upsertWorkbench(wb);
      store.selectWorkbench(wb.id);
      if (runtime === 'local') await startLocalChat(wb, model, prompt.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the workbench.');
    } finally {
      setBusy(false);
    }
  };

  const noAgent = agents.length === 0;

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-w-xl" onClose={busy ? undefined : onClose}>
        <DialogHeader>
          <DialogTitle>New workbench</DialogTitle>
          <DialogDescription>A branch with its own agent chat, diff and terminal.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="flex gap-1 rounded-md bg-muted p-1 text-xs">
            {[
              { value: false, label: 'New branch' },
              { value: true, label: 'From a pull request' },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                onClick={() => setFromPr(o.value)}
                className={cn('flex-1 rounded px-2 py-1', fromPr === o.value ? 'bg-background shadow-sm' : 'text-muted-foreground')}
              >
                {o.label}
              </button>
            ))}
          </div>
          {fromPr ? (
            <Select label="Pull request" value={prId} onChange={(e) => setPrId(e.target.value)}>
              <option value="">Choose an open pull request…</option>
              {openPrs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.owner}/{r.repo}#{r.number} — {r.summary.title}
                </option>
              ))}
            </Select>
          ) : (
            <Select label="Repository" value={repositoryId} onChange={(e) => setRepositoryId(e.target.value)}>
              {repositories.length === 0 && <option value="">No watched repositories</option>}
              {repositories.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.fullName}
                </option>
              ))}
            </Select>
          )}
          {!fromPr && (
            <Input
              label="Base branch"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              placeholder={defaultBranch || 'The repository default branch'}
            />
          )}
          <div className="space-y-1">
            <span className="text-sm font-medium">Runs in</span>
            <div className="grid grid-cols-2 gap-2">
              <RuntimeOption
                active={runtime === 'sandbox'}
                onClick={() => setRuntime('sandbox')}
                icon={Cloud}
                title="Sandbox"
                body="A Talyn Fleet microVM. Keeps working when this computer sleeps."
              />
              <RuntimeOption
                active={runtime === 'local'}
                onClick={() => bridge && setRuntime('local')}
                icon={Laptop}
                title="Worktree"
                body={bridge ? 'A git worktree on this computer, with your own tools.' : 'Needs the Talyn desktop app.'}
                disabled={!bridge}
              />
            </div>
          </div>
          {runtime === 'local' && (
            <div className="flex items-center gap-2 text-xs">
              <Button variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => void pickFolder()}>
                <FolderOpen className="h-3.5 w-3.5" /> Use an existing checkout
              </Button>
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={repoPath ?? undefined}>
                {repoPath ?? 'None chosen — Talyn clones the repository.'}
              </span>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Select label="Agent" value={agent ?? ''} onChange={(e) => setAgent(e.target.value as WorkbenchAgent)} disabled={noAgent}>
              {noAgent && <option value="">None available</option>}
              {agents.map((a) => (
                <option key={a} value={a}>
                  {AGENT_LABEL[a]}
                </option>
              ))}
            </Select>
            <div className="space-y-1">
              <span className="text-sm font-medium leading-none">Model</span>
              <div className="flex h-10 items-center rounded-md border px-2">
                {agent ? <ModelPicker agent={agent} value={model} onChange={setModel} /> : <span className="text-xs text-muted-foreground">—</span>}
              </div>
            </div>
          </div>
          {noAgent && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {runtime === 'sandbox' ? (
                <>
                  Connect Claude or Codex to Talyn Fleet first.{' '}
                  <button type="button" className="underline" onClick={() => openSettings('integrations')}>
                    Open Integrations
                  </button>
                </>
              ) : localAgents === null ? (
                'Looking for claude and codex on this computer…'
              ) : (
                'Neither `claude` nor `codex` is on your PATH. Install one, then try again.'
              )}
            </p>
          )}
          <Textarea
            label="First message (optional)"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="What should the agent do first?"
          />
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy || !repo || !agent || (fromPr && !pr)}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create workbench'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A new local workbench's first chat, and its first message when one was given. */
async function startLocalChat(wb: Workbench, model: string, prompt: string): Promise<void> {
  try {
    const chat = await api.workbenches.createChat(wb.id, { model });
    const store = useWorkbenchStore.getState();
    store.upsertChat(chat);
    store.setChatEventsState(chat.id, { loaded: true });
    store.selectChat(wb.id, chat.id);
    if (prompt) await opsFor(wb).send(chat, { text: prompt, model });
  } catch (err) {
    toast.error('The workbench is ready, but the first message did not start', err instanceof Error ? err.message : undefined);
  }
}

function RuntimeOption({
  active,
  onClick,
  icon: Icon,
  title,
  body,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Cloud;
  title: string;
  body: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        'rounded-md border p-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        active ? 'border-primary bg-primary/5' : 'hover:bg-accent/50'
      )}
    >
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <Icon className="h-3.5 w-3.5" /> {title}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{body}</p>
    </button>
  );
}
