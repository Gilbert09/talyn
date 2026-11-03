import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { SetupRecipe, SetupRecipeStep } from '@talyn/shared';
import { RepoSetupSteps } from '../components/widgets/RepoSetupSteps';

const { recipeGet, revertStep, disable, enable, navigate, toastError } = vi.hoisted(() => ({
  recipeGet: vi.fn(), revertStep: vi.fn(), disable: vi.fn(), enable: vi.fn(), navigate: vi.fn(), toastError: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  api: { repositories: { setupRecipe: { get: recipeGet, revertStep, disable, enable } } },
}));
vi.mock('../stores/navigation', () => ({ useNavigationStore: { getState: () => ({ navigate }) } }));
vi.mock('../stores/toast', () => ({ toast: { error: toastError } }));

function step(patch: Partial<SetupRecipeStep> = {}): SetupRecipeStep {
  return {
    id: 's1',
    command: 'command -v cargo >/dev/null 2>&1 || curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal',
    kind: 'rustup',
    phase: 'install',
    why: 'cargo was not found',
    source: 'learned',
    sourceWorkbenchId: 'wb-abcdef123456',
    firstSeenAt: '2026-11-01T10:00:00Z',
    lastSeenAt: '2026-11-02T10:00:00Z',
    seenCount: 3,
    appliedAt: null,
    disabledAt: null,
    disabledReason: null,
    bakeDisabledAt: null,
    bakeDisabledReason: null,
    ...patch,
  } as SetupRecipeStep;
}

function recipe(steps: SetupRecipeStep[], patch: Partial<SetupRecipe> = {}): SetupRecipe {
  return { repositoryId: 'r1', learningDisabled: false, maxSteps: 20, steps, ...patch };
}

beforeEach(() => {
  recipeGet.mockResolvedValue(recipe([step()]));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test('shows a loading state, then the step and what it carries', async () => {
  const onChange = vi.fn();
  render(<RepoSetupSteps repositoryId="r1" onChange={onChange} />);
  expect(screen.getByText('Loading setup steps…')).toBeInTheDocument();
  const row = await screen.findByText(/sh\.rustup\.rs/);
  expect(row.tagName).toBe('PRE');
  expect(screen.getByText('Rust')).toBeInTheDocument();
  expect(screen.getByText('Install')).toBeInTheDocument();
  expect(screen.getByText('cargo was not found')).toBeInTheDocument();
  expect(screen.getByText('Learned from a session')).toBeInTheDocument();
  expect(screen.getByText(/^3 times\./)).toBeInTheDocument();
  expect(screen.getByText(/goes into the bake when the steps stop changing/)).toBeInTheDocument();
  expect(screen.getByText('1 of 20 steps')).toBeInTheDocument();
  expect(onChange).toHaveBeenCalledWith(recipe([step()]));
  fireEvent.click(screen.getByRole('button', { name: 'Session wb-abcde' }));
  expect(navigate).toHaveBeenCalledWith({ view: 'workbench', id: 'wb-abcdef123456' });
});

test.each([
  { name: 'a start step', patch: { phase: 'start' as const }, badge: 'Start', text: 'On each new box' },
  { name: 'a step in the bake', patch: { appliedAt: '2026-11-02T12:00:00Z' }, badge: 'Install · in the bake', text: /^In the bake since/ },
  {
    name: 'a step out of the bake',
    patch: { appliedAt: '2026-11-02T12:00:00Z', bakeDisabledAt: '2026-11-02T13:00:00Z', bakeDisabledReason: 'exit 1' },
    badge: 'Install · out of the bake',
    text: 'The step failed in a bake: exit 1',
  },
  { name: 'an agent step', patch: { source: 'agent' as const }, badge: 'Install', text: 'Added by an agent' },
  { name: 'a step seen once', patch: { seenCount: 1 }, badge: 'Install', text: /^1 time\./ },
])('shows $name', async ({ patch, badge, text }) => {
  recipeGet.mockResolvedValue(recipe([step(patch)]));
  render(<RepoSetupSteps repositoryId="r1" />);
  expect(await screen.findByText(badge)).toBeInTheDocument();
  expect(screen.getByText(text)).toBeInTheDocument();
});

test('shows a short id and no link when a step has no session, and no why', async () => {
  recipeGet.mockResolvedValue(recipe([step({ sourceWorkbenchId: null, why: null })]));
  const { container } = render(<RepoSetupSteps repositoryId="r1" />);
  await screen.findByText(/sh\.rustup\.rs/);
  expect(container.querySelector('[data-attr="repo-setup-step-session"]')).toBeNull();
  expect(screen.queryByText('Why')).toBeNull();
});

test('reverts a step only after the in-page confirm', async () => {
  const reverted = step({ disabledAt: '2026-11-03T09:00:00Z', disabledReason: 'Reverted by a person' });
  revertStep.mockResolvedValue(recipe([reverted]));
  const onChange = vi.fn();
  render(<RepoSetupSteps repositoryId="r1" onChange={onChange} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Revert step' }));
  expect(screen.getByText(/It stops running on new boxes, and Talyn does not learn it again/)).toBeInTheDocument();
  expect(revertStep).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByText(/It stops running on new boxes/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Revert step' }));
  fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
  await waitFor(() => expect(revertStep).toHaveBeenCalledWith('r1', 's1'));
  const section = await screen.findByText('Reverted', { selector: 'h4' });
  const list = within(section.parentElement as HTMLElement);
  expect(list.getByText(/sh\.rustup\.rs/)).toBeInTheDocument();
  expect(list.getByText(/Reverted by a person/)).toBeInTheDocument();
  expect(list.queryByRole('button', { name: 'Revert step' })).toBeNull();
  expect(screen.getByText('No live steps.')).toBeInTheDocument();
  expect(onChange).toHaveBeenLastCalledWith(recipe([reverted]));
});

test('shows a toast when the revert fails', async () => {
  revertStep.mockRejectedValue(new Error('Server said no'));
  render(<RepoSetupSteps repositoryId="r1" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Revert step' }));
  fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
  await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not revert the step', 'Server said no'));
  expect(screen.getByRole('button', { name: 'Revert step' })).toBeInTheDocument();
});

test.each([
  { name: 'turns learning off', learningDisabled: false, call: disable, other: enable, checked: 'true', after: 'false' },
  { name: 'turns learning on', learningDisabled: true, call: enable, other: disable, checked: 'false', after: 'true' },
])('the switch $name', async ({ learningDisabled, call, other, checked, after }) => {
  recipeGet.mockResolvedValue(recipe([step()], { learningDisabled }));
  call.mockResolvedValue(recipe([step()], { learningDisabled: !learningDisabled }));
  render(<RepoSetupSteps repositoryId="r1" />);
  const toggle = await screen.findByRole('switch', { name: 'Learn setup steps for this repository' });
  expect(toggle).toHaveAttribute('aria-checked', checked);
  expect(screen.getByText(/When this is off, Talyn learns no new steps/)).toBeInTheDocument();
  fireEvent.click(toggle);
  await waitFor(() => expect(call).toHaveBeenCalledWith('r1'));
  expect(other).not.toHaveBeenCalled();
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', after));
});

test('shows a toast when the switch fails', async () => {
  disable.mockRejectedValue(new Error('offline'));
  render(<RepoSetupSteps repositoryId="r1" />);
  fireEvent.click(await screen.findByRole('switch'));
  await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not turn off setup step learning', 'offline'));
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
});

test('shows the empty state', async () => {
  recipeGet.mockResolvedValue(recipe([]));
  render(<RepoSetupSteps repositoryId="r1" />);
  expect(await screen.findByText('No learned steps yet. Talyn adds a step when a session installs something this repository needs.')).toBeInTheDocument();
  expect(screen.queryByText('Reverted', { selector: 'h4' })).toBeNull();
});

test('shows a load error', async () => {
  recipeGet.mockRejectedValue(new Error('Repository not found'));
  render(<RepoSetupSteps repositoryId="r1" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Repository not found');
});

test('lists live steps first and reverted steps under their own heading', async () => {
  recipeGet.mockResolvedValue(recipe([
    step({ id: 'a', command: 'echo live', kind: 'env' }),
    step({ id: 'b', command: 'echo gone', disabledAt: '2026-11-03T09:00:00Z' }),
  ]));
  const { container } = render(<RepoSetupSteps repositoryId="r1" />);
  await screen.findByText('echo live');
  const rows = Array.from(container.querySelectorAll('[data-attr="repo-setup-step"]')).map((el) => el.getAttribute('data-step-id'));
  expect(rows).toEqual(['a', 'b']);
  expect(screen.getAllByRole('button', { name: 'Revert step' })).toHaveLength(1);
  expect(screen.getByText('1 of 20 steps')).toBeInTheDocument();
});

const learned = (patch: Partial<SetupRecipeStep>) => step({ state: 'live', ...patch });

test.each([
  { state: 'waiting' as const, badge: 'Waiting' },
  { state: 'live' as const, badge: 'Runs on new boxes' },
  { state: 'failing' as const, badge: 'Failing' },
  { state: 'reverted' as const, badge: 'Reverted' },
])('shows the $badge badge for a $state step', async ({ state, badge }) => {
  recipeGet.mockResolvedValue(recipe([step({ state, disabledAt: state === 'reverted' ? '2026-11-03T09:00:00Z' : null })]));
  const { container } = render(<RepoSetupSteps repositoryId="r1" />);
  await screen.findByText(/sh\.rustup\.rs/);
  expect(container.querySelector('[data-attr="repo-setup-step-state"]')).toHaveTextContent(badge);
});

test('shows Heavy, the reason and the share', async () => {
  recipeGet.mockResolvedValue(recipe([learned({
    heavy: true, stateReason: 'Needed by 2 of 31 recent sessions', recentNeededSessions: 2, recentSessions: 31, share: 0.0645,
  })]));
  const { container } = render(<RepoSetupSteps repositoryId="r1" />);
  expect(await screen.findByText('Heavy')).toBeInTheDocument();
  expect(container.querySelector('[data-attr="repo-setup-step"]')).toHaveTextContent('Needed by 2 of 31 recent sessions');
  expect(screen.getByText('Needed by 2 of 31 recent sessions (6%).')).toBeInTheDocument();
});

test.each([
  { name: 'all numbers', patch: { lastDurationMs: 192_000, typicalDurationMs: 170_000, measuredBoxes: 7 }, text: 'Took 3m 12s (typical 2m 50s, on 7 boxes).' },
  { name: 'one box', patch: { lastDurationMs: 45_000, typicalDurationMs: 45_000, measuredBoxes: 1 }, text: 'Took 45s (typical 45s, on 1 box).' },
  { name: 'hours', patch: { lastDurationMs: 3_720_000 }, text: 'Took 1h 2m.' },
])('formats the step time: $name', async ({ patch, text }) => {
  recipeGet.mockResolvedValue(recipe([learned(patch)]));
  render(<RepoSetupSteps repositoryId="r1" />);
  expect(await screen.findByText(text)).toBeInTheDocument();
});

test('shows the box failure line for a failing step', async () => {
  recipeGet.mockResolvedValue(recipe([step({
    state: 'failing', boxFailureCount: 2, boxLastFailure: 'exit 100: E: Unable to locate package x',
    boxDisabledAt: '2026-11-03T09:00:00Z', boxDisabledReason: 'Failed on 2 boxes in a row',
  })]));
  render(<RepoSetupSteps repositoryId="r1" />);
  const line = await screen.findByText(/^Failed on 2 boxes in a row\. Last: exit 100/);
  expect(line).toHaveTextContent('Turned off on');
  expect(screen.getByText('Failing', { selector: 'h4' })).toBeInTheDocument();
});

test('shows no box failure line for a healthy step', async () => {
  recipeGet.mockResolvedValue(recipe([learned({ boxFailureCount: 0, boxLastFailure: null, boxDisabledAt: null, boxDisabledReason: null })]));
  render(<RepoSetupSteps repositoryId="r1" />);
  await screen.findByText(/sh\.rustup\.rs/);
  expect(screen.queryByText('Failures')).toBeNull();
});

test.each([
  { name: 'both parts', timing: { totalMs: 580_000, repositoryMs: 125_000, learnedMs: 455_000 }, text: /^Last setup took 9m 40s: repository setup 2m 5s, learned steps 7m 35s\./ },
  { name: 'no repository setup', timing: { totalMs: 455_000, repositoryMs: null, learnedMs: 455_000 }, text: /^Last setup took 7m 35s: learned steps 7m 35s\./ },
])('shows the last setup timing: $name', async ({ timing, text }) => {
  recipeGet.mockResolvedValue(recipe([learned({})], { lastSetupTiming: { ...timing, measuredAt: '2026-11-03T09:00:00Z', workbenchId: 'wb1' } }));
  const { container } = render(<RepoSetupSteps repositoryId="r1" />);
  await screen.findByText(/sh\.rustup\.rs/);
  const header = container.querySelector('[data-attr="repo-setup-steps-timing"]') as HTMLElement;
  expect(header.textContent).toMatch(text);
});

test('shows no timing header when none was measured', async () => {
  recipeGet.mockResolvedValue(recipe([learned({})], { lastSetupTiming: null }));
  const { container } = render(<RepoSetupSteps repositoryId="r1" />);
  await screen.findByText(/sh\.rustup\.rs/);
  expect(container.querySelector('[data-attr="repo-setup-steps-timing"]')).toBeNull();
});

test('sorts live steps slowest first and groups waiting, failing and reverted steps', async () => {
  recipeGet.mockResolvedValue(recipe([
    learned({ id: 'fast', command: 'echo fast', typicalDurationMs: 5_000 }),
    learned({ id: 'untimed', command: 'echo untimed' }),
    step({ id: 'wait', command: 'echo wait', state: 'waiting' }),
    learned({ id: 'slow', command: 'echo slow', typicalDurationMs: 200_000 }),
    step({ id: 'fail', command: 'echo fail', state: 'failing' }),
    step({ id: 'rev', command: 'echo rev', state: 'reverted', disabledAt: '2026-11-03T09:00:00Z' }),
  ]));
  const { container } = render(<RepoSetupSteps repositoryId="r1" />);
  await screen.findByText('echo slow');
  const rows = Array.from(container.querySelectorAll('[data-attr="repo-setup-step"]')).map((el) => el.getAttribute('data-step-id'));
  expect(rows).toEqual(['slow', 'fast', 'untimed', 'wait', 'fail', 'rev']);
  expect(screen.getByText('Waiting for more sessions', { selector: 'h4' })).toBeInTheDocument();
  expect(screen.getByText('Reverted', { selector: 'h4' })).toBeInTheDocument();
  expect(screen.getByText('3 of 20 steps')).toBeInTheDocument();
});

test('renders an older payload with no new fields and no new lines', async () => {
  const { container } = render(<RepoSetupSteps repositoryId="r1" />);
  await screen.findByText(/sh\.rustup\.rs/);
  expect(container.querySelector('[data-attr="repo-setup-step-state"]')).toBeNull();
  expect(container.querySelector('[data-attr="repo-setup-steps-timing"]')).toBeNull();
  for (const label of ['State', 'Use', 'Time', 'Failures']) expect(screen.queryByText(label)).toBeNull();
  expect(screen.getByText('1 of 20 steps')).toBeInTheDocument();
});
