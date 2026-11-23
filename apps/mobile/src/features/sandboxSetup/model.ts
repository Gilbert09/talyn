import {
  userSetupStepCheck, validateRepositoryBake,
  type SandboxDotfiles, type SetupListStep, type SetupListStepInput, type SetupStepKind, type SetupStepRunOn,
} from '@talyn/shared';

export const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const REBUILD_NOTE = 'A change here rebuilds your images for each repository the next time you start a session there. The first session after a change starts from the shared repository image and runs these steps itself.';
export const PRIVATE_NOTE = 'Private repositories are cloned with your GitHub connection, read-only. The token is never stored in an image.';

export const RUN_ON_LABELS: Record<SetupStepRunOn, string> = { image: 'In the image', box: 'On each box', both: 'Both' };
export const RUN_ONS: SetupStepRunOn[] = ['image', 'box', 'both'];

export const KIND_LABELS: Record<SetupStepKind, string> = {
  installer: 'Installer', rustup: 'Rust', apt: 'apt', brew: 'Homebrew', cargo: 'cargo', go: 'Go', gem: 'gem', pip: 'pip', uv: 'uv',
  node: 'Node', download: 'Download', env: 'Environment', docker: 'Docker', service: 'Service', compose: 'Compose',
  database: 'Database', other: 'Command',
};

/** Check the dotfiles form as the backend does. Null: it is good. */
export function dotfilesProblem(slug: string, install: string): string | null {
  if (!SLUG.test(slug.trim())) return 'The repository must be owner/name.';
  if (install.trim()) {
    const check = userSetupStepCheck(install);
    if (check.refusal) return check.refusal;
    if (check.forceBox) return 'The install command reads a secret. The image build has no secrets.';
  }
  return null;
}

export interface DotfilesDraft { slug: string; ref: string; install: string }

export function dotfilesDraft(dotfiles: SandboxDotfiles | null): DotfilesDraft {
  return { slug: dotfiles?.slug ?? '', ref: dotfiles?.ref ?? '', install: dotfiles?.install ?? '' };
}

export function dotfilesDirty(saved: SandboxDotfiles | null, draft: DotfilesDraft): boolean {
  const base = dotfilesDraft(saved);
  return base.slug !== draft.slug.trim() || base.ref !== draft.ref.trim() || base.install.trim() !== draft.install.trim();
}

export function dotfilesInput(draft: DotfilesDraft): SandboxDotfiles {
  return { slug: draft.slug.trim(), ref: draft.ref.trim(), install: draft.install.trim() ? draft.install.trim() : null };
}

export function dotfilesChoices(repos: string[], query: string): Array<{ slug: string; label: string }> {
  const typed = query.trim();
  const choices = repos.filter((name) => name.toLowerCase().includes(typed.toLowerCase())).map((slug) => ({ slug, label: slug }));
  if (SLUG.test(typed) && !repos.some((name) => name.toLowerCase() === typed.toLowerCase())) {
    choices.unshift({ slug: typed, label: `Use ${typed}` });
  }
  return choices;
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

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function stateFacts(step: SetupListStep): Array<{ text: string; warn?: boolean }> {
  const facts: Array<{ text: string; warn?: boolean }> = [];
  if (step.status === 'active') {
    facts.push({ text: 'Active' });
    if (step.runOn !== 'box' && !step.imageAppliedAt && !step.imageFailedAt) facts.push({ text: 'Not in the image yet' });
  } else if (step.status === 'suggested') facts.push({ text: 'Suggested' });
  else if (step.status === 'disabled') facts.push({ text: step.statusReason ? `Disabled: ${step.statusReason}` : 'Disabled', warn: true });
  else facts.push({ text: 'Dismissed' });
  if (step.imageFailedAt) facts.push({ text: `Not in the image: ${step.imageFailureReason ?? 'the image build failed'}`, warn: true });
  return facts;
}

export const canRetry = (step: SetupListStep) => step.status === 'disabled' || Boolean(step.imageFailedAt);

export interface StepFormDraft { name: string; command: string; runOn: SetupStepRunOn; timeout: string }

export function stepFormDraft(step?: SetupListStep): StepFormDraft {
  return { name: step?.name ?? '', command: step?.command ?? '', runOn: step?.runOn ?? 'image', timeout: step?.timeoutSec ? String(step.timeoutSec) : '' };
}

export function stepFormDirty(initial: StepFormDraft, draft: StepFormDraft): boolean {
  return initial.name !== draft.name || initial.command !== draft.command || initial.runOn !== draft.runOn || initial.timeout !== draft.timeout;
}

/** What the command check says about a step form while it is typed. */
export function commandCheck(command: string) {
  return command.trim() ? userSetupStepCheck(command) : { refusal: null, forceBox: null };
}

export type StepFormResult = { error: string } | { value: { name: string; command: string; runOn: SetupStepRunOn; timeoutSec: number | null } };

/** Validate a step form as the web form does. */
export function validateStepForm(draft: StepFormDraft, maxSec: number): StepFormResult {
  if (!draft.name.trim()) return { error: 'Give the step a name.' };
  if (/[\r\n]/.test(draft.name)) return { error: 'The name must be on one line.' };
  const check = userSetupStepCheck(draft.command);
  if (check.refusal) return { error: check.refusal };
  let timeoutSec: number | null = null;
  if (draft.timeout.trim()) {
    const value = Number(draft.timeout);
    if (!Number.isInteger(value) || value < 1 || value > maxSec) {
      return { error: `The time limit must be a whole number from 1 to ${maxSec} seconds.` };
    }
    timeoutSec = value;
  }
  return { value: { name: draft.name.trim(), command: draft.command, runOn: check.forceBox ? 'box' : draft.runOn, timeoutSec } };
}

export function addStepInputs(listed: SetupListStep[], value: { name: string; command: string; runOn: SetupStepRunOn; timeoutSec: number | null }): SetupListStepInput[] {
  return [...listed.map((step) => stepInput(step)), { name: value.name, command: value.command, runOn: value.runOn, timeoutSec: value.timeoutSec }];
}

export function editStepInputs(listed: SetupListStep[], step: SetupListStep, value: { name: string; command: string; runOn: SetupStepRunOn; timeoutSec: number | null }): SetupListStepInput[] {
  return listed.map((item) => item.id !== step.id ? stepInput(item) : stepInput(item, {
    name: value.name, runOn: value.runOn, timeoutSec: value.timeoutSec, ...(value.command !== step.command ? { command: value.command } : {}),
  }));
}

export function removeStepInputs(listed: SetupListStep[], id: string): SetupListStepInput[] {
  return listed.filter((step) => step.id !== id).map((step) => stepInput(step));
}

export function runOnInputs(listed: SetupListStep[], id: string, runOn: SetupStepRunOn): SetupListStepInput[] {
  return listed.map((step) => stepInput(step, step.id === id ? { runOn } : {}));
}

export function moveInputs(listed: SetupListStep[], from: number, to: number): SetupListStepInput[] | null {
  const next = moveItem(listed, from, to);
  return next === listed ? null : next.map((step) => stepInput(step));
}

export function userStepCount(listed: SetupListStep[]): number {
  return listed.filter((step) => step.origin === 'user').length;
}

export type HostResult = { skip: true } | { error: string } | { hosts: string[] };

/** Check a new allowed host as the web editor does. */
export function addHost(hosts: string[], input: string, max: number): HostResult {
  const host = input.trim().toLowerCase();
  if (!host || hosts.includes(host)) return { skip: true };
  if (hosts.length >= max) return { error: `You can add at most ${max} hosts.` };
  try {
    validateRepositoryBake({ steps: [{ name: 'hosts', run: 'true' }], hosts: [...hosts, host] });
  } catch (err) {
    return { error: err instanceof Error && err.message ? err.message : 'The host is not valid.' };
  }
  return { hosts: [...hosts, host] };
}
