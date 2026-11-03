import { useEffect, useState, type ReactNode } from 'react';
import { formatDurationMs, type SetupRecipe, type SetupRecipeStep, type SetupStepKind, type SetupStepState, type SetupTiming } from '@talyn/shared';
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

/** The step's state. An older backend sends none, so a step that is not reverted counts as live. */
export function setupStepState(step: SetupRecipeStep): SetupStepState {
  if (step.state) return step.state;
  return step.disabledAt ? 'reverted' : 'live';
}

const STATE_BADGES: Record<SetupStepState, string> = {
  waiting: 'Waiting',
  live: 'Runs on new boxes',
  failing: 'Failing',
  reverted: 'Reverted',
};

function formatShare(step: SetupRecipeStep): string | null {
  if (typeof step.recentNeededSessions !== 'number' || typeof step.recentSessions !== 'number') return null;
  const percent = typeof step.share === 'number' ? ` (${Math.round(step.share * 100)}%)` : '';
  return `Needed by ${step.recentNeededSessions} of ${step.recentSessions} recent sessions${percent}`;
}

function formatTiming(step: SetupRecipeStep): string | null {
  if (typeof step.lastDurationMs !== 'number') return null;
  const parts: string[] = [];
  if (typeof step.typicalDurationMs === 'number') parts.push(`typical ${formatDurationMs(step.typicalDurationMs)}`);
  if (step.measuredBoxes) parts.push(`on ${step.measuredBoxes} ${step.measuredBoxes === 1 ? 'box' : 'boxes'}`);
  return `Took ${formatDurationMs(step.lastDurationMs)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

/** The slowest-first order of live steps. A step with no time yet goes last. */
function bySlowest(a: SetupRecipeStep, b: SetupRecipeStep): number {
  return (b.typicalDurationMs ?? b.lastDurationMs ?? -1) - (a.typicalDurationMs ?? a.lastDurationMs ?? -1);
}

export function timingHeader(timing: SetupTiming): string {
  const repository = timing.repositoryMs === null ? '' : `repository setup ${formatDurationMs(timing.repositoryMs)}, `;
  return `Last setup took ${formatDurationMs(timing.totalMs)}: ${repository}learned steps ${formatDurationMs(timing.learnedMs)}.`;
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
  const currentState = setupStepState(step);
  if (currentState === 'waiting') {
    facts.push({ key: 'runs', label: 'Runs', value: 'Not yet. It runs when enough recent sessions need it.' });
  } else if (currentState === 'failing') {
    facts.push({ key: 'runs', label: 'Runs', value: 'No. It does not run on new boxes while it fails.' });
  } else if (step.phase === 'start') {
    facts.push({ key: 'runs', label: 'Runs', value: 'On each new box' });
  } else if (step.bakeDisabledAt) {
    facts.push({ key: 'runs', label: 'Runs', value: `On each new box. Taken out of the bake on ${formatWhen(step.bakeDisabledAt)}` });
    facts.push({ key: 'bake', label: 'Bake', value: withReason('The step failed in a bake', step.bakeDisabledReason) });
  } else if (step.appliedAt) {
    facts.push({ key: 'runs', label: 'Runs', value: `In the bake since ${formatWhen(step.appliedAt)}` });
  } else {
    facts.push({ key: 'runs', label: 'Runs', value: 'On each new box. It goes into the bake when the steps stop changing.' });
  }
  const state = currentState;
  if (step.stateReason) facts.push({ key: 'state', label: 'State', value: step.stateReason });
  const share = formatShare(step);
  if (share) facts.push({ key: 'share', label: 'Use', value: `${share}.` });
  const timing = formatTiming(step);
  if (timing) facts.push({ key: 'timing', label: 'Time', value: `${timing}.` });
  if (state === 'failing' || step.boxDisabledAt || (step.boxFailureCount ?? 0) > 0) {
    const count = step.boxFailureCount ?? 0;
    const failed = count > 0 ? `Failed on ${count} ${count === 1 ? 'box' : 'boxes'} in a row.` : 'Failed on a box.';
    const last = step.boxLastFailure ? ` Last: ${step.boxLastFailure}` : '';
    const off = step.boxDisabledAt ? ` Turned off on ${formatWhen(step.boxDisabledAt)}${step.boxDisabledReason ? `: ${step.boxDisabledReason}` : '.'}` : '';
    facts.push({ key: 'box-failure', label: 'Failures', value: `${failed}${last}${off}` });
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
  const state = setupStepState(step);
  const openSession = (id: string) => useNavigationStore.getState().navigate({ view: 'workbench', id });
  return (
    <li data-attr="repo-setup-step" data-step-id={step.id} className={cn('space-y-2 rounded border p-2', (!live || state === 'waiting' || state === 'failing') && 'opacity-60')}>
      <div className="flex flex-wrap items-center gap-1">
        <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{KIND_LABELS[step.kind] ?? step.kind}</span>
        <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{phaseBadge(step)}</span>
        {step.state && <span data-attr="repo-setup-step-state" className={cn('rounded border px-1.5 py-0.5 text-[10px]', state === 'failing' ? 'border-destructive/50 text-destructive' : 'text-muted-foreground')}>{STATE_BADGES[state]}</span>}
        {!step.state && !live && <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">Reverted</span>}
        {step.heavy && <span data-attr="repo-setup-step-heavy" className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">Heavy</span>}
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
  const running = steps.filter((step) => setupStepState(step) === 'live').sort(bySlowest);
  const waiting = steps.filter((step) => setupStepState(step) === 'waiting');
  const failing = steps.filter((step) => setupStepState(step) === 'failing');
  const reverted = steps.filter((step) => setupStepState(step) === 'reverted');
  const live = running;
  const timing = recipe.lastSetupTiming;
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
      {timing && (
        <p className="max-w-prose leading-5" data-attr="repo-setup-steps-timing">
          {timingHeader(timing)} <span className="text-muted-foreground">{formatWhen(timing.measuredAt)}</span>
        </p>
      )}
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
      {waiting.length > 0 && (
        <div className="space-y-2" data-attr="repo-setup-steps-waiting">
          <h4 className="font-medium text-muted-foreground">Waiting for more sessions</h4>
          <ul className="space-y-2">
            {waiting.map((step) => (
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
      {failing.length > 0 && (
        <div className="space-y-2" data-attr="repo-setup-steps-failing">
          <h4 className="font-medium text-muted-foreground">Failing</h4>
          <ul className="space-y-2">
            {failing.map((step) => (
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
