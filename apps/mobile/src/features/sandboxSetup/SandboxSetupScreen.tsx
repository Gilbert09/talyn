import { github, workspaces } from '@talyn/client/native';
import { redactSecrets, formatDurationMs, workbenchesOffered, type SandboxDotfiles, type SetupListStep, type SetupListStepInput, type SetupStepRunOn, type WorkspaceSandboxSetup } from '@talyn/shared';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { AppText, Banner, Button, EmptyState, Field, Group, IconButton, Input, Pill, Row, Segmented, showActionMenu } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { errorMessage } from '../../lib/errors';
import { useFeatures } from '../../lib/features';
import { Intro, Loading, Page } from '../more/Page';
import { useRemote } from '../more/useRemote';
import { TextArea } from '../settings/editors/TextArea';
import { useUnsavedGuard } from '../settings/editors/useUnsavedGuard';
import {
  KIND_LABELS, PRIVATE_NOTE, REBUILD_NOTE, RUN_ONS, RUN_ON_LABELS, addHost, addStepInputs, canRetry, commandCheck, dotfilesChoices, dotfilesDirty,
  dotfilesDraft, dotfilesInput, dotfilesProblem, editStepInputs, listedSteps, moveInputs, originLabel, removeStepInputs, runOnInputs,
  stateFacts, stepFormDirty, stepFormDraft, userStepCount, validateStepForm, type StepFormDraft,
} from './model';

type Put = (input: { dotfiles?: SandboxDotfiles | null; hosts?: string[]; steps?: SetupListStepInput[] }) => Promise<boolean>;

/** Settings → Sandbox setup: the dotfiles and the steps that every repository's image gets. Mirrors web. */
export function SandboxSetupScreen() {
  const features = useFeatures();
  const workspaceId = useWorkspace().selected;
  const offline = useNetwork() === 'offline';
  const remote = useRemote<WorkspaceSandboxSetup>(workspaceId && workbenchesOffered(features) ? `sandbox-setup:${workspaceId}` : null, () => workspaces.sandboxSetup.get(workspaceId as string));
  if (!features) return <Page><Loading /></Page>;
  if (!workbenchesOffered(features)) return <Page><EmptyState title="Not available" detail="Sandbox setup is not available for this account." /></Page>;
  if (!workspaceId) return <Page><Intro>Choose a workspace first.</Intro></Page>;
  return <Page refreshing={remote.refreshing} onRefresh={() => { void remote.refresh(); }}>
    <Intro>This setup applies to every repository of the workspace.</Intro>
    <StateNotice resource={remote} offline={offline} refresh={() => { void remote.refresh(); }} />
    {remote.data ? <SetupBody key={workspaceId} workspaceId={workspaceId} setup={remote.data} offline={offline} onSetup={(next) => remote.mutate(() => next)}
      onStep={(next) => remote.mutate((current) => ({ ...current, steps: current.steps.map((step) => step.id === next.id ? next : step) }))} /> : null}
  </Page>;
}

function SetupBody({ workspaceId, setup, offline, onSetup, onStep }: {
  workspaceId: string; setup: WorkspaceSandboxSetup; offline: boolean; onSetup(next: WorkspaceSandboxSetup): void; onStep(next: SetupListStep): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dotfilesIsDirty, setDotfilesDirty] = useState(false);
  const [formIsDirty, setFormDirty] = useState(false);
  useUnsavedGuard(dotfilesIsDirty || formIsDirty);
  const disabled = busy || offline;

  const put: Put = async (input) => {
    setBusy(true);
    setError('');
    try {
      onSetup(await workspaces.sandboxSetup.put(workspaceId, input));
      return true;
    } catch (err) {
      setError(errorMessage(err, 'Could not save the sandbox setup.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const retry = async (step: SetupListStep) => {
    setBusy(true);
    setError('');
    try {
      onStep(await workspaces.sandboxSetup.retryStep(workspaceId, step.id));
    } catch (err) {
      setError(errorMessage(err, 'Could not retry the step.'));
    } finally {
      setBusy(false);
    }
  };

  return <>
    <DotfilesForm workspaceId={workspaceId} dotfiles={setup.dotfiles} disabled={disabled} put={put} onDirty={setDotfilesDirty} />
    <StepList steps={setup.steps} limits={setup.limits} disabled={disabled} put={put} onRetry={(step) => { void retry(step); }} onFormDirty={setFormDirty} />
    <HostsEditor hosts={setup.hosts} max={setup.limits.maxHosts} disabled={disabled} put={put} />
    {error ? <Banner tone="destructive" message={error} /> : null}
    <AppText variant="meta" tone="muted" style={{ paddingHorizontal: 4 }}>{REBUILD_NOTE}</AppText>
  </>;
}

function DotfilesForm({ workspaceId, dotfiles, disabled, put, onDirty }: {
  workspaceId: string; dotfiles: SandboxDotfiles | null; disabled: boolean; put: Put; onDirty(dirty: boolean): void;
}) {
  const [draft, setDraft] = useState(dotfilesDraft(dotfiles));
  const [repos, setRepos] = useState<string[]>([]);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState('');
  const dirty = dotfilesDirty(dotfiles, draft);

  useEffect(() => { setDraft(dotfilesDraft(dotfiles)); }, [dotfiles?.slug, dotfiles?.ref, dotfiles?.install]);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => {
    let active = true;
    void github.listRepos(workspaceId).then((list) => { if (active) setRepos(list.map((repo) => repo.full_name)); }).catch(() => undefined);
    return () => { active = false; };
  }, [workspaceId]);

  const change = (patch: Partial<typeof draft>) => { setDraft((prev) => ({ ...prev, ...patch })); setError(''); };
  const choices = focused ? dotfilesChoices(repos, draft.slug).filter((choice) => choice.slug !== draft.slug).slice(0, 6) : [];

  const save = async () => {
    const problem = dotfilesProblem(draft.slug, draft.install);
    if (problem) { setError(problem); return; }
    setError('');
    await put({ dotfiles: dotfilesInput(draft) });
  };

  return <Group title="Dotfiles" footer="Each image clones this repository and runs its install command, before the steps below.">
    <View style={{ padding: 12, gap: 12 }}>
      <Field label="Repository">
        <Input accessibilityLabel="Dotfiles repository" value={draft.slug} placeholder="owner/dotfiles" autoCapitalize="none" autoCorrect={false}
          onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 150)} onChangeText={(slug) => change({ slug })} />
      </Field>
      {choices.map((choice) => <Button key={choice.slug} title={choice.label} variant="secondary" size="sm"
        onPress={() => { change({ slug: choice.slug }); setFocused(false); }} />)}
      <Field label="Branch, tag or commit">
        <Input accessibilityLabel="Dotfiles branch" value={draft.ref} placeholder="Default branch" autoCapitalize="none" autoCorrect={false} onChangeText={(ref) => change({ ref })} />
      </Field>
      <Field label="Install command">
        <Input accessibilityLabel="Dotfiles install command" value={draft.install} placeholder="install.sh, setup.sh, bootstrap, make install" autoCapitalize="none" autoCorrect={false}
          onChangeText={(install) => change({ install })} />
      </Field>
      <AppText variant="meta" tone="muted">{PRIVATE_NOTE}</AppText>
      {error ? <AppText variant="meta" tone="destructive" accessibilityRole="alert">{error}</AppText> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button title="Save dotfiles" size="sm" disabled={disabled || !dirty} onPress={() => { void save(); }} />
        {dotfiles ? <Button title="Remove dotfiles" size="sm" variant="quiet" disabled={disabled} onPress={() => { void put({ dotfiles: null }); }} /> : null}
      </View>
    </View>
  </Group>;
}

function StepList({ steps, limits, disabled, put, onRetry, onFormDirty }: {
  steps: SetupListStep[]; limits: WorkspaceSandboxSetup['limits']; disabled: boolean; put: Put; onRetry(step: SetupListStep): void; onFormDirty(dirty: boolean): void;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const listed = listedSteps(steps);
  const dismissed = steps.filter((step) => step.status === 'dismissed');
  const atLimit = userStepCount(listed) >= limits.maxUserSteps;

  return <View style={{ gap: 8 }}>
    <Group title="Steps" footer="These steps run for every repository, in this order. They come after the dotfiles and before the steps of the repository.">
      {listed.length === 0 ? <Row title="No steps yet." divider={false} /> : null}
      {listed.map((step, index) => editingId === step.id
        ? <StepForm key={step.id} step={step} maxSec={limits.stepMaxSec} disabled={disabled} submitLabel="Save step" onDirty={onFormDirty}
          onSubmit={async (value) => { const ok = await put({ steps: editStepInputs(listed, step, value) }); if (ok) setEditingId(null); return ok; }}
          onCancel={() => { setEditingId(null); onFormDirty(false); }} />
        : <StepRow key={step.id} step={step} index={index} count={listed.length} disabled={disabled}
          onMove={(to) => { const inputs = moveInputs(listed, index, to); if (inputs) void put({ steps: inputs }); }}
          onRunOn={(runOn) => { void put({ steps: runOnInputs(listed, step.id, runOn) }); }}
          onEdit={() => setEditingId(step.id)} onRemove={() => { void put({ steps: removeStepInputs(listed, step.id) }); }}
          onRetry={() => onRetry(step)} />)}
    </Group>
    {adding
      ? <StepForm maxSec={limits.stepMaxSec} disabled={disabled} submitLabel="Add step" onDirty={onFormDirty}
        onSubmit={async (value) => { const ok = await put({ steps: addStepInputs(listed, value) }); if (ok) setAdding(false); return ok; }}
        onCancel={() => { setAdding(false); onFormDirty(false); }} />
      : <Button title="Add step" variant="secondary" size="sm" disabled={disabled || atLimit} onPress={() => setAdding(true)} />}
    {atLimit ? <AppText variant="meta" tone="muted">{`A list can have at most ${limits.maxUserSteps} of your own steps.`}</AppText> : null}
    {dismissed.length > 0 ? <>
      <Button title={`${showDismissed ? 'Hide' : 'Show'} dismissed (${dismissed.length})`} variant="quiet" size="sm" onPress={() => setShowDismissed((v) => !v)} />
      {showDismissed ? <Group>{dismissed.map((step, index) => <StepRow key={step.id} step={step} index={index} count={dismissed.length} disabled={disabled} onRetry={() => onRetry(step)} />)}</Group> : null}
    </> : null}
  </View>;
}

function StepRow({ step, index, count, disabled, onMove, onRunOn, onEdit, onRemove, onRetry }: {
  step: SetupListStep; index: number; count: number; disabled: boolean; onMove?(to: number): void; onRunOn?(runOn: SetupStepRunOn): void;
  onEdit?(): void; onRemove?(): void; onRetry(): void;
}) {
  const own = step.origin === 'user';
  const runOn = step.boxOnlyReason ? 'box' : step.runOn;
  const askRunOn = () => showActionMenu(`Where "${step.name}" runs`, RUN_ONS.map((value) => ({ label: RUN_ON_LABELS[value], onPress: () => onRunOn?.(value) })));
  const confirmRemove = () => showActionMenu(`Remove "${step.name}"?`, [{ label: 'Remove', destructive: true, onPress: () => onRemove?.() }]);
  return <Row title={step.name} divider titleLines={3} subtitle={<View style={{ gap: 6 }}>
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
      <Pill label={KIND_LABELS[step.kind] ?? step.kind} />
      <Pill label={originLabel(step)} />
      {stateFacts(step).map((fact) => <Pill key={fact.text} label={fact.text} tone={fact.warn ? 'destructive' : 'muted'} />)}
    </View>
    <AppText variant="meta" selectable style={{ fontFamily: 'Menlo' }}>{redactSecrets(step.command)}</AppText>
    <AppText variant="meta" tone="muted">
      {[`Runs: ${RUN_ON_LABELS[runOn]}`, typeof step.typicalDurationMs === 'number' ? `Typical time ${formatDurationMs(step.typicalDurationMs)}` : '',
        step.timeoutSec ? `Time limit ${step.timeoutSec}s` : ''].filter(Boolean).join('. ')}
    </AppText>
    {step.boxOnlyReason ? <AppText variant="meta" tone="muted">{step.boxOnlyReason}</AppText> : null}
    {step.status === 'suggested' && (step.statusReason || step.verdictReason) ? <AppText variant="meta" tone="muted">{step.statusReason || step.verdictReason}</AppText> : null}
    {step.boxLastFailure && step.boxFailureCount > 0
      ? <AppText variant="meta" tone="muted">{`Failed on ${step.boxFailureCount} ${step.boxFailureCount === 1 ? 'box' : 'boxes'} in a row. Last: ${step.boxLastFailure}`}</AppText> : null}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
      {onMove ? <>
        <IconButton label={`Move step ${step.name} up`} symbol={{ ios: 'arrow.up', android: 'arrow_upward' }} disabled={disabled || index === 0} onPress={() => onMove(index - 1)} />
        <IconButton label={`Move step ${step.name} down`} symbol={{ ios: 'arrow.down', android: 'arrow_downward' }} disabled={disabled || index === count - 1} onPress={() => onMove(index + 1)} />
      </> : null}
      {canRetry(step) ? <Button title="Retry" size="sm" variant="secondary" disabled={disabled} onPress={onRetry} /> : null}
      {onRunOn && !step.boxOnlyReason ? <Button title="Change where it runs" size="sm" variant="quiet" disabled={disabled} onPress={askRunOn} /> : null}
      {step.imageFailedAt && step.runOn !== 'box' && onRunOn ? <Button title="Run on each box instead" size="sm" variant="quiet" disabled={disabled} onPress={() => onRunOn('box')} /> : null}
      {own && onEdit ? <Button title="Edit" size="sm" variant="quiet" disabled={disabled} onPress={onEdit} /> : null}
      {own && onRemove ? <Button title="Remove" size="sm" variant="quiet" disabled={disabled} onPress={confirmRemove} /> : null}
    </View>
  </View>} />;
}

function StepForm({ step, maxSec, disabled, submitLabel, onSubmit, onCancel, onDirty }: {
  step?: SetupListStep; maxSec: number; disabled: boolean; submitLabel: string;
  onSubmit(value: { name: string; command: string; runOn: SetupStepRunOn; timeoutSec: number | null }): Promise<boolean>; onCancel(): void; onDirty(dirty: boolean): void;
}) {
  const initial = stepFormDraft(step);
  const [draft, setDraft] = useState<StepFormDraft>(initial);
  const [error, setError] = useState('');
  const check = commandCheck(draft.command);
  const runOn = check.forceBox ? 'box' : draft.runOn;
  const dirty = stepFormDirty(initial, draft);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  const change = (patch: Partial<StepFormDraft>) => { setDraft((prev) => ({ ...prev, ...patch })); setError(''); };

  const submit = async () => {
    const result = validateStepForm(draft, maxSec);
    if ('error' in result) { setError(result.error); return; }
    setError('');
    await onSubmit(result.value);
  };

  return <Group>
    <View style={{ padding: 12, gap: 12 }}>
      <Field label="Name"><Input accessibilityLabel="Step name" value={draft.name} onChangeText={(name) => change({ name })} placeholder="Name" /></Field>
      <Field label="Command"><TextArea code minHeight={90} accessibilityLabel="Step command" value={draft.command} onChangeText={(command) => change({ command })} placeholder="Command" /></Field>
      <Field label="Runs">
        <Segmented accessibilityLabel="Step runs" value={runOn} options={RUN_ONS.map((value) => ({ value, label: RUN_ON_LABELS[value] }))}
          onChange={(value) => { if (!check.forceBox) change({ runOn: value }); }} />
      </Field>
      <Field label="Time limit (seconds)">
        <Input accessibilityLabel="Step time limit in seconds" value={draft.timeout} keyboardType="number-pad" placeholder="Default" onChangeText={(timeout) => change({ timeout })} />
      </Field>
      {check.forceBox ? <AppText variant="meta" tone="muted">{check.forceBox}</AppText> : null}
      {error || check.refusal ? <AppText variant="meta" tone="destructive" accessibilityRole="alert">{error || check.refusal}</AppText> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button title={submitLabel} size="sm" disabled={disabled || Boolean(check.refusal)} onPress={() => { void submit(); }} />
        <Button title="Cancel" size="sm" variant="quiet" onPress={onCancel} />
      </View>
    </View>
  </Group>;
}

function HostsEditor({ hosts, max, disabled, put }: { hosts: string[]; max: number; disabled: boolean; put: Put }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const add = async () => {
    const result = addHost(hosts, input, max);
    if ('skip' in result) { setInput(''); return; }
    if ('error' in result) { setError(result.error); return; }
    setError('');
    if (await put({ hosts: result.hosts })) setInput('');
  };
  return <Group title="Allowed extra hosts" footer="The image build can reach these hosts too. Use them for downloads that the build needs.">
    {hosts.map((host) => <Row key={host} title={host} trailing={<IconButton label={`Remove host ${host}`} symbol={{ ios: 'xmark', android: 'close' }} disabled={disabled}
      onPress={() => { void put({ hosts: hosts.filter((other) => other !== host) }); }} />} />)}
    <View style={{ padding: 12, gap: 8 }}>
      <Input accessibilityLabel="Allowed extra host" value={input} placeholder="downloads.example.com" autoCapitalize="none" autoCorrect={false}
        onChangeText={(text) => { setInput(text); setError(''); }} onSubmitEditing={() => { void add(); }} />
      {error ? <AppText variant="meta" tone="destructive" accessibilityRole="alert">{error}</AppText> : null}
      <Button title="Add host" size="sm" variant="secondary" disabled={disabled || hosts.length >= max} onPress={() => { void add(); }} />
    </View>
  </Group>;
}
