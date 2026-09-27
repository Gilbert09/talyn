import { describe, it, expect } from 'vitest';
import { DEFAULT_MERGE_QUEUE_MODE } from '@talyn/shared';

/**
 * What a NEW workspace's queue does, and only a new one.
 *
 * The distinction is the whole point. 'eager' is seeded into a workspace's
 * settings AT CREATION; the resolver's fall-back for an ABSENT key stays
 * 'ordered'. Those are different claims about different workspaces: a workspace
 * with no `mergeQueueMode` is not one that wants today's default, it is one that
 * has been draining in order — possibly for months, possibly with entries queued
 * right now. Moving the resolver's fall-back would reorder those live queues on
 * deploy, having asked nobody.
 *
 * So this file asserts BOTH halves. Changing either one alone is the bug.
 */
describe('merge queue default mode', () => {
  it('seeds new workspaces eager', () => {
    expect(DEFAULT_MERGE_QUEUE_MODE).toBe('eager');
  });

  it('leaves an absent setting resolving to ordered', async () => {
    // Read from the resolver's own source rather than restated, so this fails if
    // somebody "tidies" the two into agreement.
    const { readFileSync } = await import('fs');
    const src = readFileSync(
      new URL('../services/mergeQueue/store.ts', import.meta.url),
      'utf8'
    );
    expect(src).toContain("=== 'eager' ? 'eager' : 'ordered'");
  });

  it.each([
    ['routes/workspaces.ts', '../routes/workspaces.ts'],
    ['services/workspaceBootstrap.ts', '../services/workspaceBootstrap.ts'],
  ])('seeds the default at the %s creation path', async (_label, rel) => {
    // Both paths must seed it. Bootstrap is the one every brand-new account
    // actually takes, so seeding only the create route would apply the default
    // to nobody but a second, hand-made workspace.
    const { readFileSync } = await import('fs');
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
    expect(src).toContain('mergeQueueMode: DEFAULT_MERGE_QUEUE_MODE');
  });
});
