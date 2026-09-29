import { reviewStage } from '../renderer/components/panels/codeReview/reviewStage';

/**
 * The Code review list's colour per row — one stage each, most-final first.
 *
 * Duplicated in apps/web on purpose: the renderer is a deliberate fork.
 */
const base = {
  prState: 'open' as const,
  phase: 'ready' as const,
  openCount: 0,
  blockers: 0,
  fixStatus: null,
  progressLabel: 'Reviewing 2/4',
};

describe('reviewStage', () => {
  it.each([
    ['a merged PR, whatever it found', { prState: 'merged', openCount: 3, blockers: 1 }, 'merged', 'Merged', 'purple'],
    ['a closed PR', { prState: 'closed' }, 'closed', 'Closed', 'grey'],
    ['an agent fixing it', { fixStatus: 'in_progress', openCount: 2 }, 'fixing', 'Fixing', 'indigo'],
    ['the review\'s own fix phase', { phase: 'fixing' }, 'fixing', 'Fixing', 'indigo'],
    ['a review still running', { phase: 'reviewing' }, 'reviewing', 'Reviewing 2/4', 'blue'],
    ['a review that failed', { phase: 'failed' }, 'failed', 'Did not finish', 'red'],
    ['a review somebody stopped', { phase: 'cancelled' }, 'stopped', 'Stopped', 'grey'],
    ['open findings with a blocker', { openCount: 2, blockers: 1 }, 'needs_fixes', '2 findings', 'red'],
    ['open findings, none blocking', { openCount: 1 }, 'needs_fixes', '1 finding', 'amber'],
    ['nothing left open', {}, 'ready', 'Ready for review', 'green'],
    ['a pushed fix with nothing left open', { phase: 'fixed' }, 'ready', 'Fixed · ready for review', 'green'],
  ] as const)('%s → %s', (_l, over, stage, label, tone) => {
    expect(reviewStage({ ...base, ...over })).toEqual({ stage, label, tone });
  });
});
