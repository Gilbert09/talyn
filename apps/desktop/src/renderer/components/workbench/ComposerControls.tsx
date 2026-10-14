import React, { useState } from 'react';
import { CheckCircle2, ChevronDown, Circle, ListTodo, Loader2, NotebookPen } from 'lucide-react';
import {
  FLEET_MODELS,
  WORKBENCH_EFFORTS,
  defaultFleetModelForAgent,
  type WorkbenchAgent,
  type WorkbenchContextUsage,
  type WorkbenchEffort,
  type WorkbenchTodo,
} from '@talyn/shared';
import { cn } from '../../lib/utils';
import { formatTokens } from '../../lib/workbenchFormat';

/** The models the workbench's agent can run: the fleet catalogue, filtered by vendor. */
export function modelsForAgent(agent: WorkbenchAgent): Array<{ id: string; label: string }> {
  return FLEET_MODELS.filter((m) => (agent === 'codex' ? m.provider === 'openai' : m.provider === 'anthropic')).map(
    (m) => ({ id: m.id, label: m.label })
  );
}

export function defaultModelFor(agent: WorkbenchAgent): string {
  return defaultFleetModelForAgent(agent);
}

// Self-contained against @tailwindcss/forms: its base styles give every select
// py-2, a line-height and a chevron background that clip text in a h-6 box.
const selectClass =
  'h-6 appearance-none rounded border border-transparent bg-transparent bg-none py-0 pl-1 pr-5 text-[11px] leading-tight text-muted-foreground hover:border-input hover:text-foreground focus:border-input focus:outline-none disabled:opacity-50';

function PickerSelect({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative inline-flex items-center">
      <select {...props} className={selectClass}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1 h-3 w-3 text-muted-foreground" />
    </span>
  );
}

export function ModelPicker({
  agent,
  value,
  onChange,
  disabled,
}: {
  agent: WorkbenchAgent;
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
}) {
  const models = modelsForAgent(agent);
  const known = models.some((m) => m.id === value);
  return (
    <PickerSelect
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      title="Model"
      aria-label="Model"
    >
      {!known && <option value={value}>{value}</option>}
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </PickerSelect>
  );
}

const EFFORT_LABEL: Record<WorkbenchEffort, string> = {
  low: 'Low effort',
  medium: 'Medium effort',
  high: 'High effort',
  xhigh: 'Extra-high effort',
  max: 'Max effort',
};

export function EffortPicker({
  value,
  onChange,
  disabled,
}: {
  value: WorkbenchEffort;
  onChange: (effort: WorkbenchEffort) => void;
  disabled?: boolean;
}) {
  return (
    <PickerSelect
      value={value}
      onChange={(e) => onChange(e.target.value as WorkbenchEffort)}
      disabled={disabled}
      title="Reasoning effort"
      aria-label="Reasoning effort"
    >
      {WORKBENCH_EFFORTS.map((e) => (
        <option key={e} value={e}>
          {EFFORT_LABEL[e]}
        </option>
      ))}
    </PickerSelect>
  );
}

export function PlanToggle({ on, onToggle, disabled }: { on: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={on}
      className={cn(
        'inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] transition-colors',
        on ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
      title="Plan mode: the agent reads and plans but does not edit (⇧Tab)"
    >
      <NotebookPen className="h-3 w-3" />
      Plan
    </button>
  );
}

export function ContextMeter({ usage }: { usage: WorkbenchContextUsage | null }) {
  if (!usage) return null;
  const pct = Math.round(usage.fraction * 100);
  const tone = usage.fraction >= 0.85 ? 'bg-red-500' : usage.fraction >= 0.6 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div
      className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
      title={`Context: ${formatTokens(usage.usedTokens)} of ${formatTokens(usage.contextWindow)} tokens`}
      aria-label={`Context ${pct}% full`}
    >
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full', tone)} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <span className="tabular-nums">{pct}%</span>
    </div>
  );
}

/** The agent's latest to-do list, as a chip that opens into the full list. */
export function TodoChip({ todos }: { todos: WorkbenchTodo[] | null }) {
  const [open, setOpen] = useState(false);
  if (!todos || todos.length === 0) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  const current = todos.find((t) => t.status === 'in_progress');
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-6 max-w-[16rem] items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-expanded={open}
        title="The agent's to-do list"
      >
        <ListTodo className="h-3 w-3 shrink-0" />
        <span className="tabular-nums">
          {done}/{todos.length}
        </span>
        {current && <span className="truncate">· {current.activeForm ?? current.content}</span>}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-20 mb-1 w-80 rounded-md border bg-popover p-2 text-popover-foreground shadow-lg">
          <ul className="space-y-1">
            {todos.map((t, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs">
                {t.status === 'completed' ? (
                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
                ) : t.status === 'in_progress' ? (
                  <Loader2 className="mt-0.5 h-3 w-3 shrink-0 animate-spin text-amber-500" />
                ) : (
                  <Circle className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                )}
                <span className={cn(t.status === 'completed' && 'text-muted-foreground line-through')}>{t.content}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
