import type { WorkbenchReadiness } from '@talyn/shared';

import { agentReady, agentStepSkippable, onboardingGate, stepIndex, type OnboardingGateInput } from '../navigation/onboardingGate';
import type { LoadState } from '../workflow/model';

const ready = (agents: Partial<Record<'claude' | 'codex', boolean>> = { claude: true, codex: false }, ok = true): WorkbenchReadiness => ({
  sandbox: { ok, reasons: ok ? [] : [{ code: 'fleet_disabled', message: 'Paused.' }],
    agents: { claude: { ok: agents.claude ?? false }, codex: { ok: agents.codex ?? false } } },
});
const loaded = <T,>(data: T) => ({ status: 'ready' as LoadState, data });
const state = (status: LoadState) => ({ status, data: undefined });
const github = loaded({ integrations: { github: { enabled: true, watchedRepos: [] } } });
const noGithub = loaded({ integrations: {} });

const input = (patch: Partial<OnboardingGateInput> = {}): OnboardingGateInput => ({
  workspace: github, repositories: loaded([{ id: 'r' }]), readiness: loaded(ready()), inProgress: true, ...patch,
});

describe('onboarding gate', () => {
  it.each<[string, Partial<OnboardingGateInput>, ReturnType<typeof onboardingGate>]>([
    ['the workspace is still idle', { workspace: state('idle') }, 'loading'],
    ['the workspace is loading', { workspace: state('loading') }, 'loading'],
    ['the workspace failed to load', { workspace: state('error') }, 'done'],
    ['the device is offline with nothing cached', { workspace: state('offline') }, 'done'],
    ['the workspace is not allowed', { workspace: state('unauthorized') }, 'done'],
    ['the workspace is gone', { workspace: state('deleted') }, 'done'],
    ['GitHub is not connected on a new account', { workspace: noGithub, inProgress: false }, 'github'],
    ['GitHub is not connected and the progress is loading', { workspace: noGithub, inProgress: undefined }, 'github'],
    ['GitHub has no integrations object', { workspace: loaded({ integrations: null }) }, 'github'],
    ['GitHub was disconnected mid-setup', { workspace: noGithub, repositories: loaded([]) }, 'github'],
    ['a returning account with GitHub and nothing else', { inProgress: false, repositories: loaded([]), readiness: loaded(ready({})) }, 'done'],
    ['the device progress is still loading', { inProgress: undefined }, 'loading'],
    ['repositories are loading', { repositories: state('loading') }, 'loading'],
    ['repositories failed to load', { repositories: state('error') }, 'repos'],
    ['no repository is watched', { repositories: loaded([]) }, 'repos'],
    ['readiness is loading', { readiness: state('idle') }, 'loading'],
    ['readiness failed to load', { readiness: state('error') }, 'agent'],
    ['no agent is connected', { readiness: loaded(ready({})) }, 'agent'],
    ['the sandbox is down', { readiness: loaded(ready({ claude: true }, false)) }, 'agent'],
    ['Claude is connected', { readiness: loaded(ready({ claude: true })) }, 'done'],
    ['only Codex is connected', { readiness: loaded(ready({ codex: true })) }, 'done'],
  ])('when %s', (_name, patch, expected) => expect(onboardingGate(input(patch))).toBe(expected));

  it.each([
    ['nothing loaded', undefined, false],
    ['no agent', ready({}), false],
    ['one agent', ready({ codex: true }), true],
    ['an agent on a sandbox that is down', ready({ claude: true }, false), false],
  ])('agentReady with %s', (_name, readiness, expected) => expect(agentReady(readiness)).toBe(expected));

  it.each([
    ['nothing loaded', undefined, false],
    ['no agent connected on a working sandbox', ready({}), false],
    ['an agent connected', ready({ claude: true }), false],
    ['a sandbox that is down', ready({}, false), true],
  ])('agentStepSkippable with %s', (_name, readiness, expected) => expect(agentStepSkippable(readiness)).toBe(expected));

  it.each([['github', 0], ['repos', 1], ['agent', 2], ['notifications', 3]] as const)('puts %s at position %i', (step, index) => expect(stepIndex(step)).toBe(index));
});
