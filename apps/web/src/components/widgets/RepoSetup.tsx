import { useEffect, useState } from 'react';
import {
  formatDurationMs,
  type PutRepositorySetupInput,
  type RepoSetupRunOnBox,
  type RepoSetupSource,
  type RepositorySetup,
  type SandboxImageLayer,
  type SetupImageStatus,
  type SetupTiming,
} from '@talyn/shared';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { SetupHostsEditor, SetupStepList, errorText, formatWhen } from './SetupList';

const hint = 'Each new box runs this list in order. Steps that run in the image go into a shared image, so a new box starts with their result. Steps that run on each box run after the box starts.';
const learningHint = 'When this is off, Talyn suggests no new steps from sessions. The steps in the list still run.';

const SOURCE_LABELS: Record<RepoSetupSource, string | null> = {
  talyn: '.talyn/settings.toml',
  'conductor-json': 'conductor.json',
  'conductor-toml': '.conductor/settings.toml',
  none: null,
};

const RUN_ON_BOX_LABELS: Record<RepoSetupRunOnBox, string> = {
  always: 'Always',
  moved: 'Only when the checkout moved',
  never: 'Never',
};

const LAYER_LABELS: Record<SandboxImageLayer, string> = {
  base: 'the base image',
  legacy: 'an older image',
  repo: 'the shared repository image',
  user: 'your image',
};

/** The line under row 0 that says what the image holds of the repository's own setup. */
export function repoSetupImageLine(image: SetupImageStatus | null): string | null {
  if (!image || image.repoLayerPending) return 'Image not built yet';
  if (image.repoSetupOk === false) return 'The repository setup failed in the image build. Each box runs it.';
  if ((image.layer === 'repo' || image.layer === 'user') && image.repoCommit) {
    return `Built into the shared image at ${image.repoCommit.slice(0, 7)}`;
  }
  return null;
}

/** "Last box: ready in 40s, checkout 5s, ...": only the times the box sent. */
export function lastBoxTimingLine(timing: SetupTiming): string | null {
  const parts: string[] = [];
  const add = (label: string, value: number | null | undefined) => {
    if (typeof value === 'number') parts.push(`${label} ${formatDurationMs(value)}`);
  };
  add('ready in', timing.boxReadyMs);
  add('checkout', timing.checkoutMs);
  add('repository setup', timing.setupRepositoryMs);
  add('setup steps', timing.setupBoxStepsMs);
  return parts.length ? `Last box: ${parts.join(', ')}.` : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function timingHistoryLine(history: SetupTiming[]): string | null {
  const ready = history.map((timing) => timing.boxReadyMs).filter((value): value is number => typeof value === 'number');
  if (ready.length === 0) return null;
  const sessions = ready.length === 1 ? 'Last session' : `Last ${ready.length} sessions`;
  return `${sessions}: ready in ${formatDurationMs(median(ready))} median.`;
}

function imageStatusLine(image: SetupImageStatus | null): string {
  if (!image) return 'No box has started yet, so Talyn has no image status.';
  const layer = image.layer ? `The newest box started from ${LAYER_LABELS[image.layer] ?? image.layer}.` : 'Talyn does not know which image the newest box started from.';
  const pending = image.userLayerPending ? ' Next build: pending.' : '';
  return `${layer} Checked ${formatWhen(image.checkedAt)}.${pending}`;
}

/**
 * Settings → Repositories → <repository> → Setup. Row 0 is the repository's
 * own setup, then one ordered list of steps. Every change saves at once.
 */
export function RepoSetup({ repositoryId, onChange }: {
  repositoryId: string;
  onChange?: (setup: RepositorySetup) => void;
}) {
  const [setup, setSetup] = useState<RepositorySetup | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setSetup(null);
    setLoadError('');
    void api.repositories.setup.get(repositoryId).then((next) => {
      if (!active) return;
      setSetup(next);
      onChange?.(next);
    }).catch((err) => { if (active) setLoadError(errorText(err, 'Could not load the setup.')); });
    return () => { active = false; };
  }, [repositoryId]);

  const act = async (fn: () => Promise<RepositorySetup>, failure: string): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      const next = await fn();
      setSetup(next);
      onChange?.(next);
      return true;
    } catch (err) {
      setError(errorText(err, failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const put = (input: PutRepositorySetupInput, failure = 'Could not save the setup.') =>
    act(() => api.repositories.setup.put(repositoryId, input), failure);

  if (loadError) return <p role="alert" className="text-xs text-destructive" data-attr="repo-setup">{loadError}</p>;
  if (!setup) return <p className="text-xs text-muted-foreground" data-attr="repo-setup">Loading the setup…</p>;

  const { repoSetup, image, limits } = setup;
  const source = repoSetup.source ? SOURCE_LABELS[repoSetup.source] : null;
  const imageLine = repoSetupImageLine(image);
  const lastTiming = setup.lastSetupTiming ? lastBoxTimingLine(setup.lastSetupTiming) : null;
  const history = timingHistoryLine(setup.timingHistory ?? []);
  const learning = !setup.learningDisabled;

  return (
    <div className="min-w-0 space-y-4 text-xs" data-attr="repo-setup">
      <p className="max-w-prose leading-5 text-muted-foreground">{hint}</p>
      <div className="space-y-2 rounded border bg-muted/30 p-2" data-attr="repo-setup-row0">
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 font-medium">Repository setup</span>
          <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">From the repository</span>
        </div>
        {repoSetup.command ? (
          <pre className="whitespace-pre-wrap break-all rounded bg-background px-2 py-1 font-mono text-[11px]">{repoSetup.command}</pre>
        ) : (
          <p className="text-muted-foreground">{repoSetup.readAt ? 'No setup command in the repository' : 'Not read yet. A session reads it when its box starts.'}</p>
        )}
        <p className="text-muted-foreground">
          {source ? <>From <span className="font-mono">{source}</span>. </> : null}
          Edit it in the repository.
        </p>
        {imageLine && <p className="text-muted-foreground" data-attr="repo-setup-image-line">{imageLine}</p>}
        <label className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Run on each box</span>
          <select
            aria-label="Run the repository setup on each box"
            value={repoSetup.runOnBox}
            disabled={busy}
            onChange={(event) => void put({ runOnBox: event.target.value as RepoSetupRunOnBox })}
            className="rounded border bg-background px-1 py-0.5"
          >
            {(Object.keys(RUN_ON_BOX_LABELS) as RepoSetupRunOnBox[]).map((value) => (
              <option key={value} value={value}>{RUN_ON_BOX_LABELS[value]}</option>
            ))}
          </select>
        </label>
      </div>
      <SetupStepList
        steps={setup.steps}
        busy={busy}
        maxSec={limits.stepMaxSec}
        maxUserSteps={limits.maxUserSteps}
        emptyText="No steps yet. Add a step, or Talyn suggests one when sessions install something this repository needs."
        onPut={(steps) => put({ steps })}
        actions={{
          onAccept: (step) => void act(() => api.repositories.setup.acceptStep(repositoryId, step.id), 'Could not add the step.'),
          onDismiss: (step) => void act(() => api.repositories.setup.dismissStep(repositoryId, step.id), 'Could not dismiss the step.'),
          onRetry: (step) => void act(() => api.repositories.setup.retryStep(repositoryId, step.id), 'Could not retry the step.'),
        }}
      />
      {error && <p role="alert" className="max-w-prose text-destructive" data-attr="repo-setup-error">{error}</p>}
      <div className="space-y-1 border-t pt-3 text-muted-foreground" data-attr="repo-setup-footer">
        <p data-attr="repo-setup-image-status">{imageStatusLine(image)}</p>
        {lastTiming && <p data-attr="repo-setup-last-timing">{lastTiming}</p>}
        {history && <p data-attr="repo-setup-history">{history}</p>}
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={learning}
            aria-label="Learn setup steps from sessions"
            data-attr="repo-setup-learning"
            disabled={busy}
            onClick={() => void put({ learningDisabled: learning })}
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
              learning ? 'bg-primary' : 'bg-muted',
            )}
          >
            <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform', learning ? 'translate-x-4' : 'translate-x-0.5')} />
          </button>
          <span>Learn setup steps from sessions</span>
        </div>
        <p className="max-w-prose leading-5 text-muted-foreground">{learningHint}</p>
      </div>
      <SetupHostsEditor
        inputId={`setup-host-${repositoryId}`}
        hosts={setup.hosts}
        max={limits.maxHosts}
        busy={busy}
        onSave={(hosts) => put({ hosts })}
      />
    </div>
  );
}
