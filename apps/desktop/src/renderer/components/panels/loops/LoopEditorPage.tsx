import { useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { CloudAgentChoice, LoopInput, LoopWithStats } from '@talyn/shared';
import {
  cronForPreset,
  describeSchedule,
  emptyLoopInput,
  localTimezone,
  LOOP_CONCURRENCIES,
  LOOP_CONCURRENCY_LABELS,
  LOOP_SCHEDULE_PRESETS,
  loopInputProblem,
  loopToInput,
  MAX_LOOP_NAME_LENGTH,
  nextLoopRuns,
  presetForCron,
  WEEKDAY_LABELS,
  type LoopSchedulePresetKind,
} from '@talyn/shared';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Select } from '../../ui/select';
import { Textarea } from '../../ui/textarea';
import { cn } from '../../../lib/utils';
import { useWorkspaceStore } from '../../../stores/workspace';
import { Section, TextField } from '../workflows/workflowFields';

/**
 * The loop editor.
 *
 * A PAGE rather than a modal, and not a route — the `WorkflowEditorPage`
 * reasoning applies unchanged: `activePanel` is the app's whole routing
 * vocabulary and `PANEL_PATHS` is a flat record of static paths, so a
 * parameterised `/loops/:id` would mean changing that contract on the web fork
 * while the desktop kept view state anyway. The honest cost is no deep link to
 * one loop's editor.
 *
 * Validation is quiet until the first Save attempt, then live — the
 * `workflowInputProblem` pattern. A form that turns red while somebody is still
 * typing the first field is a form that is shouting at them for not having
 * finished.
 */

/** A common timezone list, with the browser's own zone guaranteed to be in it. */
function timezoneOptions(current: string): string[] {
  const common = [
    'UTC',
    'Europe/London',
    'Europe/Berlin',
    'Europe/Lisbon',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'Asia/Tokyo',
    'Asia/Singapore',
    'Australia/Sydney',
  ];
  const local = localTimezone();
  return [...new Set([local, current, ...common].filter(Boolean))];
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = [0, 5, 10, 15, 20, 30, 45];

export function LoopEditorPage({
  editing,
  agents,
  onCancel,
  onSave,
}: {
  editing: LoopWithStats | null;
  agents: CloudAgentChoice[];
  onCancel: () => void;
  onSave: (input: LoopInput) => Promise<void>;
}) {
  const repositories = useWorkspaceStore((s) => s.repositories);
  const [input, setInput] = useState<LoopInput>(() =>
    editing ? loopToInput(editing) : emptyLoopInput()
  );
  // The preset is derived state, not stored state: the cron expression is the
  // one source of truth, and reading it back is what lets a loop saved as
  // "Daily 09:00" re-open as that rather than as a raw cron box.
  const [preset, setPreset] = useState<LoopSchedulePresetKind>(
    () => presetForCron(editing?.cron ?? '0 9 * * *').kind
  );
  const [fields, setFields] = useState(() => presetForCron(editing?.cron ?? '0 9 * * *').fields);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const problem = useMemo(() => loopInputProblem(input), [input]);

  /** Re-render the cron string whenever a schedule control moves. */
  const applySchedule = (kind: LoopSchedulePresetKind, next: typeof fields) => {
    setPreset(kind);
    setFields(next);
    setInput((p) => ({ ...p, cron: cronForPreset(kind, next) }));
  };

  // The preview. The editor and the scheduler compute this with the same
  // function, so what is shown here is what will actually happen.
  const preview = useMemo(
    () => nextLoopRuns(input.cron, input.timezone, new Date(), 3),
    [input.cron, input.timezone]
  );

  const agentKey = (a: CloudAgentChoice) => `${a.type}:${a.agent ?? ''}`;
  const selectedAgent = useMemo(
    () =>
      agents.find((a) => a.type === input.provider && (!a.agent || a.models.some((m) => m.id === input.model))) ??
      agents.find((a) => a.type === input.provider) ??
      null,
    [agents, input.provider, input.model]
  );

  const pickAgent = (key: string) => {
    const agent = agents.find((a) => agentKey(a) === key);
    if (!agent) return;
    // The model moves with the agent. It has to: the fleet's two agents have
    // disjoint catalogues, so keeping the old model when switching from Claude
    // to Codex would leave a pair the validator refuses.
    setInput((p) => ({
      ...p,
      provider: agent.type === 'selfhosted' ? 'selfhosted' : 'posthog_code',
      model: agent.model ?? agent.models[0]?.id ?? p.model,
    }));
  };

  const save = async () => {
    setAttempted(true);
    if (problem) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(input);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save this loop');
    } finally {
      setSaving(false);
    }
  };

  const presetSpec = LOOP_SCHEDULE_PRESETS.find((p) => p.kind === preset);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-6 py-4">
        <Button variant="ghost" size="sm" onClick={onCancel} data-attr="loop-editor-back">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Loops
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">
            {input.name.trim() || (editing ? 'Loop' : 'New loop')}
          </h1>
        </div>
        {/* Only when editing. A loop you are creating is on — nobody composes a
            schedule in order to leave it switched off. */}
        {editing && (
          <Button
            variant={input.enabled === false ? 'outline' : 'secondary'}
            size="sm"
            onClick={() => setInput((p) => ({ ...p, enabled: p.enabled === false }))}
          >
            {input.enabled === false ? 'Off' : 'On'}
          </Button>
        )}
        <Button onClick={save} disabled={saving} data-attr="loop-save">
          {saving ? 'Saving...' : editing ? 'Save' : 'Create'}
        </Button>
      </header>

      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl space-y-4 p-6">
          {(saveError ?? (attempted ? problem : null)) && (
            <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-500">
              {saveError ?? problem}
            </p>
          )}

          <Section title="Name" description="What this loop is for, in a few words.">
            <TextField
              value={input.name}
              onChange={(name) => setInput((p) => ({ ...p, name: name.slice(0, MAX_LOOP_NAME_LENGTH) }))}
              placeholder="Triage yesterday's failing checks"
            />
          </Section>

          <Section
            title="Prompt"
            description="The whole instruction the agent receives. It has the repository checked out and can open a pull request."
          >
            <Textarea
              rows={6}
              value={input.prompt}
              onChange={(e) => setInput((p) => ({ ...p, prompt: e.target.value }))}
              placeholder="Look through the open PRs you have permission to touch and rebase any that have fallen behind main."
            />
          </Section>

          <Section title="Schedule" description={presetSpec?.hint}>
            <div className="flex flex-wrap gap-1">
              {LOOP_SCHEDULE_PRESETS.map((spec) => (
                <button
                  key={spec.kind}
                  onClick={() => applySchedule(spec.kind, fields)}
                  className={cn(
                    'inline-flex items-center rounded-full border px-2.5 py-1 text-xs transition-colors',
                    preset === spec.kind
                      ? 'border-transparent bg-primary text-primary-foreground'
                      : 'hover:bg-accent'
                  )}
                >
                  {spec.label}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-end gap-3">
              {presetSpec?.fields.includes('weekday') && (
                <label className="text-xs font-medium text-muted-foreground">
                  Day
                  <Select
                    className="mt-1 block"
                    value={String(fields.weekday)}
                    onChange={(e) =>
                      applySchedule(preset, { ...fields, weekday: Number(e.target.value) })
                    }
                  >
                    {WEEKDAY_LABELS.map((label, i) => (
                      <option key={label} value={i}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              {presetSpec?.fields.includes('hour') && (
                <label className="text-xs font-medium text-muted-foreground">
                  Hour
                  <Select
                    className="mt-1 block"
                    value={String(fields.hour)}
                    onChange={(e) => applySchedule(preset, { ...fields, hour: Number(e.target.value) })}
                  >
                    {HOURS.map((h) => (
                      <option key={h} value={h}>
                        {String(h).padStart(2, '0')}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              {presetSpec?.fields.includes('minute') && (
                <label className="text-xs font-medium text-muted-foreground">
                  Minute
                  <Select
                    className="mt-1 block"
                    value={String(fields.minute)}
                    onChange={(e) =>
                      applySchedule(preset, { ...fields, minute: Number(e.target.value) })
                    }
                  >
                    {MINUTES.map((m) => (
                      <option key={m} value={m}>
                        {String(m).padStart(2, '0')}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              {presetSpec?.fields.includes('expression') && (
                <label className="flex-1 text-xs font-medium text-muted-foreground">
                  Cron expression
                  <Input
                    className="mt-1 font-mono"
                    value={fields.expression}
                    onChange={(e) =>
                      applySchedule(preset, { ...fields, expression: e.target.value })
                    }
                    placeholder="0 */4 * * *"
                  />
                </label>
              )}
              <label className="text-xs font-medium text-muted-foreground">
                Timezone
                <Select
                  className="mt-1 block"
                  value={input.timezone}
                  onChange={(e) => setInput((p) => ({ ...p, timezone: e.target.value }))}
                >
                  {timezoneOptions(input.timezone).map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </Select>
              </label>
            </div>

            <div className="rounded-md border bg-card/40 p-3 text-xs">
              <div className="font-medium">{describeSchedule(input.cron, input.timezone)}</div>
              {/* The preview is the honest test of a cron expression: "0 0 30 2 *"
                  validates and never fires, and only a list of dates shows it. */}
              <div className="mt-1 text-muted-foreground">
                {preview.length === 0
                  ? 'This schedule has no upcoming runs.'
                  : `Next: ${preview
                      .map((d) =>
                        d.toLocaleString(undefined, {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                          timeZone: input.timezone,
                        })
                      )
                      .join(' · ')}`}
              </div>
            </div>
          </Section>

          <Section
            title="Repository"
            description="Every run clones this repository. A loop works on one."
          >
            <Select
              value={input.repositoryId}
              onChange={(e) => {
                const repo = repositories.find((r) => r.id === e.target.value);
                setInput((p) => ({
                  ...p,
                  repositoryId: repo?.id ?? '',
                  repoFullName: repo?.fullName ?? '',
                }));
              }}
            >
              <option value="">Pick a repository...</option>
              {repositories.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.fullName}
                </option>
              ))}
            </Select>
          </Section>

          <Section
            title="Agent"
            description="Which agent runs the prompt, and on which model."
          >
            {agents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No agents are connected to this workspace. Connect one in Settings &rarr;
                Integrations before a loop can run.
              </p>
            ) : (
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-xs font-medium text-muted-foreground">
                  Agent
                  <Select
                    className="mt-1 block"
                    value={selectedAgent ? agentKey(selectedAgent) : ''}
                    onChange={(e) => pickAgent(e.target.value)}
                  >
                    {agents.map((a) => (
                      <option key={agentKey(a)} value={agentKey(a)}>
                        {a.displayName}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="flex-1 text-xs font-medium text-muted-foreground">
                  Model
                  <Select
                    className="mt-1 block"
                    value={input.model}
                    onChange={(e) => setInput((p) => ({ ...p, model: e.target.value }))}
                  >
                    {(selectedAgent?.models ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} — {m.blurb}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
            )}
          </Section>

          <Section
            title="If the last run is still going"
            description="A run can take longer than the gap to the next one."
          >
            <div className="flex flex-wrap gap-1">
              {LOOP_CONCURRENCIES.map((value) => (
                <button
                  key={value}
                  onClick={() => setInput((p) => ({ ...p, concurrency: value }))}
                  className={cn(
                    'inline-flex items-center rounded-full border px-2.5 py-1 text-xs transition-colors',
                    (input.concurrency ?? 'skip') === value
                      ? 'border-transparent bg-primary text-primary-foreground'
                      : 'hover:bg-accent'
                  )}
                >
                  {LOOP_CONCURRENCY_LABELS[value]}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Skipping is recorded in the history, so a loop that keeps standing down is visible
              rather than silent. Start it anyway when the prompt is safe to run twice at once.
            </p>
          </Section>

          {/* The same action as the header's, where you finish reading. */}
          <div className="flex items-center justify-end gap-3 border-t pt-4">
            {attempted && problem && <p className="flex-1 text-xs text-red-500">{problem}</p>}
            <Button variant="ghost" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving} data-attr="loop-save-inline">
              {saving ? 'Saving...' : editing ? 'Save changes' : 'Create loop'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
