import { useState, type DragEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import {
  formatDurationMs,
  redactSecrets,
  userSetupStepCheck,
  validateRepositoryBake,
  type SetupListStep,
  type SetupListStepInput,
  type SetupStepKind,
  type SetupStepRunOn,
} from '@talyn/shared';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';

export const RUN_ON_LABELS: Record<SetupStepRunOn, string> = {
  image: 'In the image',
  box: 'On each box',
  both: 'Both',
};

const RUN_ONS: SetupStepRunOn[] = ['image', 'box', 'both'];

export const KIND_LABELS: Record<SetupStepKind, string> = {
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
  other: 'Command',
};

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function originLabel(step: SetupListStep): string {
  if (step.origin === 'user') return 'You';
  if (step.origin === 'agent') return 'Agent recorded it';
  if (typeof step.recentNeededSessions === 'number' && typeof step.recentSessions === 'number' && step.recentSessions > 0) {
    return `Talyn learned it from ${step.recentNeededSessions} of ${step.recentSessions} sessions`;
  }
  return 'Talyn learned it';
}

/** The PUT input that keeps a row as it is. Every field is sent, because the backend sets an absent time limit to none. */
export function stepInput(step: SetupListStep, patch: Partial<SetupListStepInput> = {}): SetupListStepInput {
  return { id: step.id, name: step.name, runOn: step.runOn, timeoutSec: step.timeoutSec, ...patch };
}

/** The rows a PUT orders. Dismissed rows stay out: the backend keeps them, after the list. */
export function listedSteps(steps: SetupListStep[]): SetupListStep[] {
  return steps.filter((step) => step.status !== 'dismissed');
}

/** Move one item of a list from one place to another. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function Badge({ children, tone, attr }: { children: ReactNode; tone?: 'warn' | 'muted'; attr?: string }) {
  return (
    <span
      data-attr={attr}
      className={cn(
        'rounded border px-1.5 py-0.5 text-[10px]',
        tone === 'warn' ? 'border-destructive/50 text-destructive' : 'text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

export interface StepFormValue {
  name: string;
  command: string;
  runOn: SetupStepRunOn;
  timeoutSec: number | null;
}

/** Name, command, where it runs and an optional time limit. Checks the command as the backend does. */
export function SetupStepForm({ initial, maxSec, busy, submitLabel, onSubmit, onCancel }: {
  initial?: StepFormValue;
  maxSec: number;
  busy: boolean;
  submitLabel: string;
  onSubmit: (value: StepFormValue) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [runOn, setRunOn] = useState<SetupStepRunOn>(initial?.runOn ?? 'image');
  const [timeout, setTimeoutText] = useState(initial?.timeoutSec ? String(initial.timeoutSec) : '');
  const [error, setError] = useState('');
  const check = command.trim() ? userSetupStepCheck(command) : { refusal: null, forceBox: null };
  const effectiveRunOn: SetupStepRunOn = check.forceBox ? 'box' : runOn;

  const submit = async () => {
    if (!name.trim()) { setError('Give the step a name.'); return; }
    if (/[\r\n]/.test(name)) { setError('The name must be on one line.'); return; }
    const full = userSetupStepCheck(command);
    if (full.refusal) { setError(full.refusal); return; }
    let timeoutSec: number | null = null;
    if (timeout.trim()) {
      const value = Number(timeout);
      if (!Number.isInteger(value) || value < 1 || value > maxSec) {
        setError(`The time limit must be a whole number from 1 to ${maxSec} seconds.`);
        return;
      }
      timeoutSec = value;
    }
    setError('');
    await onSubmit({ name: name.trim(), command, runOn: effectiveRunOn, timeoutSec });
  };

  return (
    <div className="space-y-2 rounded border bg-background p-2" data-attr="setup-step-form">
      <input
        aria-label="Step name"
        value={name}
        onChange={(event) => { setName(event.target.value); setError(''); }}
        placeholder="Name"
        className="w-full rounded border bg-background px-2 py-1"
      />
      <textarea
        aria-label="Step command"
        value={command}
        onChange={(event) => { setCommand(event.target.value); setError(''); }}
        placeholder="Command"
        rows={3}
        className="w-full rounded border bg-background px-2 py-1 font-mono"
      />
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          Runs
          <select
            aria-label="Step runs"
            value={effectiveRunOn}
            disabled={!!check.forceBox}
            onChange={(event) => setRunOn(event.target.value as SetupStepRunOn)}
            className="rounded border bg-background px-1 py-0.5"
          >
            {RUN_ONS.map((value) => <option key={value} value={value}>{RUN_ON_LABELS[value]}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Time limit (seconds)
          <input
            aria-label="Step time limit in seconds"
            type="number"
            min={1}
            max={maxSec}
            value={timeout}
            onChange={(event) => { setTimeoutText(event.target.value); setError(''); }}
            placeholder="Default"
            className="w-24 rounded border bg-background px-2 py-1"
          />
        </label>
      </div>
      {check.forceBox && <p className="text-muted-foreground" data-attr="setup-step-force-box">{check.forceBox}</p>}
      {(error || check.refusal) && <p role="alert" className="text-destructive">{error || check.refusal}</p>}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !!check.refusal} onClick={() => void submit()}>{submitLabel}</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

interface RowActions {
  onAccept?: (step: SetupListStep) => void;
  onDismiss?: (step: SetupListStep) => void;
  onRetry?: (step: SetupListStep) => void;
}

function stateFacts(step: SetupListStep): { text: string; tone?: 'warn' }[] {
  const facts: { text: string; tone?: 'warn' }[] = [];
  if (step.status === 'active') {
    facts.push({ text: 'Active' });
    if (step.runOn !== 'box' && !step.imageAppliedAt && !step.imageFailedAt) facts.push({ text: 'Not in the image yet' });
  } else if (step.status === 'suggested') {
    facts.push({ text: 'Suggested' });
  } else if (step.status === 'disabled') {
    facts.push({ text: step.statusReason ? `Disabled: ${step.statusReason}` : 'Disabled', tone: 'warn' });
  } else {
    facts.push({ text: 'Dismissed' });
  }
  if (step.imageFailedAt) facts.push({ text: `Not in the image: ${step.imageFailureReason ?? 'the image build failed'}`, tone: 'warn' });
  return facts;
}

function SetupStepRow({ step, index, count, busy, actions, onMove, onRunOn, onEdit, onRemove, maxSec, drag }: {
  step: SetupListStep;
  index: number;
  count: number;
  busy: boolean;
  actions: RowActions;
  onMove?: (from: number, to: number) => void;
  onRunOn?: (runOn: SetupStepRunOn) => void;
  onEdit?: (value: StepFormValue) => Promise<boolean>;
  onRemove?: () => void;
  maxSec: number;
  drag?: {
    onDragStart: (event: DragEvent) => void;
    onDragOver: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void;
    onDragEnd: () => void;
    over: boolean;
  };
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const own = step.origin === 'user';
  const reorderable = !!onMove;
  const facts = stateFacts(step);
  const label = `step ${step.name}`;

  if (editing && onEdit) {
    return (
      <li data-attr="setup-step" data-step-id={step.id}>
        <SetupStepForm
          initial={{ name: step.name, command: step.command, runOn: step.runOn, timeoutSec: step.timeoutSec }}
          maxSec={maxSec}
          busy={busy}
          submitLabel="Save step"
          onSubmit={async (value) => {
            const ok = await onEdit(value);
            if (ok) setEditing(false);
            return ok;
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  }

  return (
    <li
      data-attr="setup-step"
      data-step-id={step.id}
      data-status={step.status}
      draggable={reorderable && !busy}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
      className={cn(
        'space-y-2 rounded border p-2',
        (step.status === 'suggested' || step.status === 'dismissed' || step.status === 'disabled') && 'bg-muted/30',
        drag?.over && 'border-primary',
      )}
    >
      <div className="flex items-start gap-2">
        {reorderable && (
          <div className="flex shrink-0 flex-col items-center text-muted-foreground">
            <GripVertical className="h-3.5 w-3.5 cursor-grab" aria-hidden />
            <button type="button" aria-label={`Move ${label} up`} disabled={busy || index === 0} onClick={() => onMove(index, index - 1)} className="disabled:opacity-30">
              <ArrowUp className="h-3 w-3" />
            </button>
            <button type="button" aria-label={`Move ${label} down`} disabled={busy || index === count - 1} onClick={() => onMove(index, index + 1)} className="disabled:opacity-30">
              <ArrowDown className="h-3 w-3" />
            </button>
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 font-medium">{step.name}</span>
            <Badge>{KIND_LABELS[step.kind] ?? step.kind}</Badge>
            <Badge attr="setup-step-origin">{originLabel(step)}</Badge>
            {facts.map((fact) => <Badge key={fact.text} tone={fact.tone} attr="setup-step-state">{fact.text}</Badge>)}
          </div>
          <pre className="whitespace-pre-wrap break-all rounded bg-background px-2 py-1 font-mono text-[11px]">{redactSecrets(step.command)}</pre>
          <div className="flex flex-wrap items-center gap-3 text-[11px]">
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Runs</span>
              <select
                aria-label={`Where ${label} runs`}
                value={step.boxOnlyReason ? 'box' : step.runOn}
                disabled={busy || !!step.boxOnlyReason || !onRunOn}
                title={step.boxOnlyReason ?? undefined}
                onChange={(event) => onRunOn?.(event.target.value as SetupStepRunOn)}
                className="rounded border bg-background px-1 py-0.5"
              >
                {RUN_ONS.map((value) => <option key={value} value={value}>{RUN_ON_LABELS[value]}</option>)}
              </select>
            </label>
            {typeof step.typicalDurationMs === 'number' && (
              <span className="text-muted-foreground" data-attr="setup-step-time">Typical time {formatDurationMs(step.typicalDurationMs)}</span>
            )}
            {step.timeoutSec ? <span className="text-muted-foreground">Time limit {step.timeoutSec}s</span> : null}
          </div>
          {step.boxOnlyReason && <p className="text-[11px] text-muted-foreground" data-attr="setup-step-box-only">{step.boxOnlyReason}</p>}
          {step.status === 'suggested' && step.statusReason && <p className="text-[11px] text-muted-foreground">{step.statusReason}</p>}
          {step.status === 'suggested' && !step.statusReason && step.verdictReason && <p className="text-[11px] text-muted-foreground">{step.verdictReason}</p>}
          {step.boxLastFailure && step.boxFailureCount > 0 && (
            <p className="text-[11px] text-muted-foreground">Failed on {step.boxFailureCount} {step.boxFailureCount === 1 ? 'box' : 'boxes'} in a row. Last: {step.boxLastFailure}</p>
          )}
          <div className="flex flex-wrap items-center gap-1">
            {step.status === 'suggested' && actions.onAccept && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => actions.onAccept?.(step)}>{step.statusReason ? 'Restore' : 'Add'}</Button>
            )}
            {step.status === 'suggested' && actions.onDismiss && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => actions.onDismiss?.(step)}>Dismiss</Button>
            )}
            {step.status === 'dismissed' && actions.onAccept && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => actions.onAccept?.(step)}>Restore</Button>
            )}
            {(step.status === 'disabled' || step.imageFailedAt) && actions.onRetry && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => actions.onRetry?.(step)}>Retry</Button>
            )}
            {step.imageFailedAt && step.runOn !== 'box' && onRunOn && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRunOn('box')}>Run on each box instead</Button>
            )}
            {own && onEdit && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>Edit</Button>}
            {own && onRemove && (confirming ? (
              <>
                <span>Remove this step?</span>
                <Button size="sm" variant="destructive" disabled={busy} onClick={() => { setConfirming(false); onRemove(); }}>Remove</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>Remove</Button>
            ))}
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * One ordered Setup list. Every change saves at once with `onPut`, which gets
 * the whole new order of the listed rows. Dismissed rows go in a closed group
 * at the end.
 */
export function SetupStepList({ steps, busy, maxSec, maxUserSteps, onPut, actions, emptyText }: {
  steps: SetupListStep[];
  busy: boolean;
  maxSec: number;
  maxUserSteps: number;
  onPut: (inputs: SetupListStepInput[]) => Promise<boolean>;
  actions: RowActions;
  emptyText: string;
}) {
  const [adding, setAdding] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const listed = listedSteps(steps);
  const dismissed = steps.filter((step) => step.status === 'dismissed');
  const userCount = listed.filter((step) => step.origin === 'user').length;

  const putOrder = (order: SetupListStep[], change?: { id: string; patch: Partial<SetupListStepInput> }) =>
    onPut(order.map((step) => stepInput(step, change && change.id === step.id ? change.patch : {})));

  const move = (from: number, to: number) => {
    const next = moveItem(listed, from, to);
    if (next !== listed) void putOrder(next);
  };

  return (
    <div className="space-y-2" data-attr="setup-step-list">
      {listed.length === 0 ? (
        <p className="text-muted-foreground" data-attr="setup-steps-empty">{emptyText}</p>
      ) : (
        <ol className="space-y-2">
          {listed.map((step, index) => (
            <SetupStepRow
              key={step.id}
              step={step}
              index={index}
              count={listed.length}
              busy={busy}
              actions={actions}
              maxSec={maxSec}
              onMove={move}
              onRunOn={(runOn) => void putOrder(listed, { id: step.id, patch: { runOn } })}
              onEdit={step.origin === 'user'
                ? (value) => putOrder(listed, {
                  id: step.id,
                  patch: { name: value.name, runOn: value.runOn, timeoutSec: value.timeoutSec, ...(value.command !== step.command ? { command: value.command } : {}) },
                })
                : undefined}
              onRemove={step.origin === 'user' ? () => void onPut(listed.filter((other) => other.id !== step.id).map((other) => stepInput(other))) : undefined}
              drag={{
                onDragStart: (event) => {
                  setDragFrom(index);
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', step.id);
                },
                onDragOver: (event) => {
                  if (dragFrom === null) return;
                  event.preventDefault();
                  setDragOver(index);
                },
                onDrop: (event) => {
                  event.preventDefault();
                  if (dragFrom !== null) move(dragFrom, index);
                  setDragFrom(null);
                  setDragOver(null);
                },
                onDragEnd: () => { setDragFrom(null); setDragOver(null); },
                over: dragOver === index && dragFrom !== null && dragFrom !== index,
              }}
            />
          ))}
        </ol>
      )}
      {adding ? (
        <SetupStepForm
          maxSec={maxSec}
          busy={busy}
          submitLabel="Add step"
          onSubmit={async (value) => {
            const ok = await onPut([
              ...listed.map((step) => stepInput(step)),
              { name: value.name, command: value.command, runOn: value.runOn, timeoutSec: value.timeoutSec },
            ]);
            if (ok) setAdding(false);
            return ok;
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || userCount >= maxUserSteps}
          title={userCount >= maxUserSteps ? `A list can have at most ${maxUserSteps} of your own steps.` : undefined}
          onClick={() => setAdding(true)}
        >
          Add step
        </Button>
      )}
      {dismissed.length > 0 && (
        <div className="space-y-2" data-attr="setup-steps-dismissed">
          <button type="button" aria-expanded={showDismissed} className="text-muted-foreground hover:underline" onClick={() => setShowDismissed((value) => !value)}>
            Dismissed ({dismissed.length})
          </button>
          {showDismissed && (
            <ul className="space-y-2">
              {dismissed.map((step, index) => (
                <SetupStepRow key={step.id} step={step} index={index} count={dismissed.length} busy={busy} actions={actions} maxSec={maxSec} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Extra hosts the image build may reach. Checks each host with the bake rule, which the backend uses too. */
export function SetupHostsEditor({ hosts, max, busy, onSave, inputId }: {
  hosts: string[];
  max: number;
  busy: boolean;
  onSave: (hosts: string[]) => Promise<boolean>;
  inputId: string;
}) {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');

  const add = async () => {
    const host = input.trim().toLowerCase();
    if (!host) return;
    if (hosts.includes(host)) { setInput(''); return; }
    if (hosts.length >= max) { setError(`You can add at most ${max} hosts.`); return; }
    try {
      validateRepositoryBake({ steps: [{ name: 'hosts', run: 'true' }], hosts: [...hosts, host] });
    } catch (err) {
      setError(errorText(err, 'The host is not valid.'));
      return;
    }
    setError('');
    if (await onSave([...hosts, host])) setInput('');
  };

  return (
    <div className="space-y-2" data-attr="setup-hosts">
      <label htmlFor={inputId} className="font-medium">Allowed extra hosts</label>
      <p className="max-w-prose text-muted-foreground">The image build can reach these hosts too. Use them for downloads that the build needs.</p>
      {hosts.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {hosts.map((host) => (
            <span key={host} className="rounded border px-1">
              {host}{' '}
              <button type="button" aria-label={`Remove host ${host}`} disabled={busy} onClick={() => void onSave(hosts.filter((other) => other !== host))}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          id={inputId}
          value={input}
          onChange={(event) => { setInput(event.target.value); setError(''); }}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void add(); } }}
          placeholder="downloads.example.com"
          className="min-w-32 flex-1 rounded border bg-background px-2 py-1"
        />
        <Button size="sm" variant="outline" disabled={busy || hosts.length >= max} onClick={() => void add()}>Add host</Button>
      </div>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  );
}
