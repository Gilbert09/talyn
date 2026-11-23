import type { PRRow } from '@talyn/client/native';
import type { Workbench } from '@talyn/shared';

jest.mock('../auth/AuthProvider', () => ({ useMobileRuntime: jest.fn(), useNetwork: () => 'online' }));

import { canClosePr, quickMenuActions } from '../features/sessions/DetailHeader';
import { pr, session, thread } from './workflowFixtures';

const mine = (patch: Partial<PRRow> = {}) => pr({ authored: true, ...patch });
const openedBySession = pr({ authored: false, summary: { ...pr().summary, createdAt: '2026-11-08T11:00:00Z' } });
const openedBefore = pr({ authored: false, summary: { ...pr().summary, createdAt: '2026-11-01T10:00:00Z' } });

describe('canClosePr', () => {
  it.each<[string, Workbench, PRRow | null, boolean]>([
    ['an open PR the person opened', session(), mine(), true],
    ['an open PR this session opened', session(), openedBySession, true],
    ['a PR somebody else opened before the session', session(), openedBefore, false],
    ['a PR with no author or open date', session(), pr(), false],
    ['a merged PR', session(), mine({ state: 'merged' }), false],
    ['a closed PR', session(), mine({ state: 'closed' }), false],
    ['no PR row yet', session(), null, false],
    ['an archived session', session({ archivedAt: '2026-11-09T10:00:00Z' }), mine(), false],
    ['a thread', thread(), mine(), false],
  ])('%s: %p', (_name, item, row, expected) => {
    expect(canClosePr(item, row)).toBe(expected);
  });
});

describe('quickMenuActions close entry', () => {
  const entry = (row: PRRow | null, options: Partial<Parameters<typeof quickMenuActions>[2]> = {}) =>
    quickMenuActions(session(), row, { offline: false, busy: false, run: jest.fn(), ...options })
      .find((action) => action.label === 'Close pull request');

  it('comes last, marked destructive, and runs close_pr', () => {
    const run = jest.fn();
    const actions = quickMenuActions(session(), mine(), { offline: false, busy: false, run });
    const close = actions.at(-1)!;
    expect(close).toMatchObject({ label: 'Close pull request', destructive: true, disabled: false });
    close.onPress();
    expect(run).toHaveBeenCalledWith('close_pr');
  });

  it('is absent for a PR the person cannot close', () => {
    expect(entry(openedBefore)).toBeUndefined();
  });

  it.each([
    ['offline', { offline: true }, 'You are offline.'],
    ['busy', { busy: true }, undefined],
  ])('is disabled while %s', (_name, options, detail) => {
    expect(entry(mine(), options)).toMatchObject({ disabled: true, detail });
  });
});
