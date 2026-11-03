import { useEffect, useState, type ReactNode } from 'react';
import type { SetupRecipe, SetupRecipeStep, SetupStepKind } from '@talyn/shared';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toast';
import { useNavigationStore } from '../../stores/navigation';
import { Button } from '../ui/button';

const hint = 'Talyn learns these steps from the tools that sessions install on this repository. Each new box runs them after the repository setup. Install steps also go into the bake.';
const learningHint = 'When this is off, Talyn learns no new steps, and new boxes do not run the learned steps.';
const emptyText = 'No learned steps yet. Talyn adds a step when a session installs something this repository needs.';

const KIND_LABELS: Record<SetupStepKind, string> = {
  installer: 'Installer',
  rustup: 'Rust',
  apt: 'apt',
  brew: 'Homebrew',
  cargo: 'cargo',
  go: 'Go',
  gem: 'gem',
  pip: 'pip',
  uv: 'uv',
  node: 'Node',
  download: 'Download',
  env: 'Environment',
  docker: 'Docker',
  service: 'Service',
  compose: 'Compose',
  database: 'Database',
  other: 'Other',
};

/** True when the step is not reverted, so it runs on new boxes. */
export function isLiveSetupStep(step: SetupRecipeStep): boolean {
  return !step.disabledAt;
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function withReason(text: string, reason: string | null | undefined): string {
  return reason ? `${text}: ${reason}` : `${text}.`;
}

interface StepFact {
  key: string;
  label: string;
  value: ReactNode;
}

/**
 * The facts a step row shows, one per line. To show a new field of
 * `SetupRecipeStep`, add one entry here.
 */
function stepFacts(step: SetupRecipeStep, openSession: (id: string) => void): StepFact[] {
  const facts: StepFact[] = [];
  if (step.phase === 'start') {
    facts.push({ key: 'runs', label: 'Runs', value: 'On each new box' });
  } else if (step.bakeDisabledAt) {
    facts.push({ key: 'runs', label: 'Runs', value: `On each new box. Taken out of the bake on ${formatWhen(step.bakeDisabledAt)}` });
    facts.push({ key: 'bake', label: 'Bake', value: withReason('The step failed in a bake', step.bakeDisabledReason) });
  } else if (step.appliedAt) {
    facts.push({ key: 'runs', label: 'Runs', value: `In the bake since ${formatWhen(step.appliedAt)}` });
  } else {
    facts.push({ key: 'runs', label: 'Runs', value: 'On each new box. It goes into the bake when the steps stop changing.' });
  }
  if (step.why) facts.push({ key: 'why', label: 'Why', value: step.why });
  facts.push({ key: 'source', label: 'Source', value: step.source === 'agent' ? 'Added by an agent' : 'Learned from a session' });
  if (step.sourceWorkbenchId) {
    const id = step.sourceWorkbenchId;
    facts.push({
      key: 'session',
      label: 'First needed by',
      value: (
        <button type="button" data-attr="repo-setup-step-session" className="text-primary underline-offset-2 hover:underline" title={id} onClick={() => openSession(id)}>
          Session {id.slice(0, 8)}
        </button>
      ),
    });
  }
  const times = step.seenCount === 1 ? '1 time' : `${step.seenCount} times`;
  facts.push({ key: 'seen', label: 'Seen', value: `${times}. First on ${formatWhen(step.firstSeenAt)}, last on ${formatWhen(step.lastSeenAt)}.` });
  if (step.disabledAt) {
    facts.push({ key: 'reverted', label: 'Reverted', value: withReason(formatWhen(step.disabledAt), step.disabledReason) });
  }
  return facts;
}

function phaseBadge(step: SetupRecipeStep): string {
  if (step.phase === 'start') return 'Start';
  if (step.bakeDisabledAt) return 'Install · out of the bake';
  return step.appliedAt ? 'Install · in the bake' : 'Install';
}

function StepRow({ step, busy, onRevert }: {
  step: SetupRecipeStep;
  busy: boolean;
  onRevert?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const live = isLiveSetupStep(step);
  const openSession = (id: string) => useNavigationStore.getState().navigate({ view: 'workbench', id });
  return (
    <li data-attr="repo-setup-step" data-step-id={step.id} className={cn('space-y-2 rounded border p-2', !live && 'opacity-60')}>
      <div className="flex flex-wrap items-center gap-1">
        <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{KIND_LABELS[step.kind] ?? step.kind}</span>
        <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{phaseBadge(step)}</span>
        {!live && <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">Reverted</span>}
      </div>
      <pre className="whitespace-pre-wrap break-all rounded bg-background px-2 py-1 font-mono text-[11px]">{step.command}</pre>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11px] leading-5">
        {stepFacts(step, openSession).map((fact) => (
          <div key={fact.key} className="contents">
            <dt className="text-muted-foreground">{fact.label}</dt>
            <dd className="min-w-0 break-words">{fact.value}</dd>
          </div>
        ))}
      </dl>
      {live && onRevert && (confirming ? (
        <div className="flex flex-wrap items-center gap-2" data-attr="repo-setup-step-revert-confirm">
          <span className="max-w-prose">Revert this step? It stops running on new boxes, and Talyn does not learn it again.</span>
          <Button data-attr="repo-setup-step-confirm-revert" variant="destructive" size="sm" disabled={busy} onClick={() => { setConfirming(false); onRevert(); }}>Revert</Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
        </div>
      ) : (
        <Button data-attr="repo-setup-step-revert" variant="ghost" size="sm" className="w-fit" disabled={busy} onClick={() => setConfirming(true)}>Revert step</Button>
      ))}
    </li>
  );
}

export function RepoSetupSteps({ repositoryId, onChange }: {
  repositoryId: string;
  onChange?: (recipe: SetupRecipe) => void;
}) {
  const [recipe, setRecipe] = useState<SetupRecipe | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setRecipe(null);
    setError('');
    void api.repositories.setupRecipe.get(repositoryId).then((next) => {
      if (!active) return;
      setRecipe(next);
      onChange?.(next);
    }).catch((err) => { if (active) setError(err instanceof Error ? err.message : 'Could not load setup steps.'); });
    return () => { active = false; };
  }, [repositoryId]);

  const act = async (fn: () => Promise<SetupRecipe>, failure: string) => {
    setBusy(true);
    try {
      const next = await fn();
      setRecipe(next);
      onChange?.(next);
    } catch (err) {
      toast.error(failure, err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p role="alert" className="text-xs text-destructive" data-attr="repo-setup-steps">{error}</p>;
  if (!recipe) return <p className="text-xs text-muted-foreground" data-attr="repo-setup-steps">Loading setup steps…</p>;

  const steps = Array.isArray(recipe.steps) ? recipe.steps : [];
  const live = steps.filter(isLiveSetupStep);
  const reverted = steps.filter((step) => !isLiveSetupStep(step));
  const learning = !recipe.learningDisabled;

  return (
    <div className="min-w-0 space-y-4 text-xs" data-attr="repo-setup-steps">
      <p className="max-w-prose leading-5 text-muted-foreground">{hint}</p>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={learning}
            aria-label="Learn setup steps for this repository"
            data-attr="repo-setup-steps-learning"
            disabled={busy}
            onClick={() => void act(
              () => (learning ? api.repositories.setupRecipe.disable(repositoryId) : api.repositories.setupRecipe.enable(repositoryId)),
              learning ? 'Could not turn off setup step learning' : 'Could not turn on setup step learning',
            )}
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
              learning ? 'bg-primary' : 'bg-muted',
            )}
          >
            <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform', learning ? 'translate-x-4' : 'translate-x-0.5')} />
          </button>
          <span>Learn setup steps for this repository</span>
        </div>
        <p className="max-w-prose leading-5 text-muted-foreground">{learningHint}</p>
      </div>
      {live.length === 0 ? (
        <p className="text-muted-foreground" data-attr="repo-setup-steps-empty">{steps.length === 0 ? emptyText : 'No live steps.'}</p>
      ) : (
        <div className="space-y-2">
          <p className="text-muted-foreground">{live.length} of {recipe.maxSteps} steps</p>
          <ul className="space-y-2">
            {live.map((step) => (
              <StepRow
                key={step.id}
                step={step}
                busy={busy}
                onRevert={() => void act(() => api.repositories.setupRecipe.revertStep(repositoryId, step.id), 'Could not revert the step')}
              />
            ))}
          </ul>
        </div>
      )}
      {reverted.length > 0 && (
        <div className="space-y-2" data-attr="repo-setup-steps-reverted">
          <h4 className="font-medium text-muted-foreground">Reverted</h4>
          <ul className="space-y-2">
            {reverted.map((step) => <StepRow key={step.id} step={step} busy={busy} />)}
          </ul>
        </div>
      )}
    </div>
  );
}
