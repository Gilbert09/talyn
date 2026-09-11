import { afterEach, describe, expect, it } from 'vitest';
import {
  workflowsEnabled,
  workflowsRefusalReason,
  workspaceMayUseWorkflows,
} from '../services/workflowsAccess.js';

/**
 * The Workflows kill switch.
 *
 * This file used to test an allow-list keyed on the workspace owner's email,
 * where unset meant NOBODY. Workflows is released now, so the polarity is
 * inverted and the property worth pinning is the opposite one: **absent means
 * ON**, and only an explicit `false` stops it.
 *
 * Getting that backwards is not symmetric. A gate that fails closed hides a
 * feature people paid no attention to; a kill switch that fails closed takes a
 * shipped feature away from everybody on the next deployment that forgets a line
 * of env — silently, because nothing errors.
 */

describe('workflowsEnabled', () => {
  afterEach(() => delete process.env.WORKFLOWS_ENABLED);

  it.each([
    [undefined, true],
    ['', true],
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    // Only these two switch it off.
    ['false', false],
    ['FALSE', false],
    ['0', false],
    ['  false  ', false],
  ])('WORKFLOWS_ENABLED=%j → %s', (value, expected) => {
    if (value === undefined) delete process.env.WORKFLOWS_ENABLED;
    else process.env.WORKFLOWS_ENABLED = value as string;
    expect(workflowsEnabled()).toBe(expected);
  });

  it('a typo turns the feature ON rather than silently off', () => {
    // The safer failure for a kill switch: "it stopped working and nobody knows
    // why" is much harder to notice than the thing you were trying to stop.
    process.env.WORKFLOWS_ENABLED = 'flase';
    expect(workflowsEnabled()).toBe(true);
  });

  it('no longer reads an allow-list', () => {
    // The env var is gone from the code; a stale value left on a deployment must
    // not resurrect a gate that no longer exists.
    process.env.WORKFLOWS_ALLOWED_EMAILS = 'somebody-else@example.test';
    expect(workflowsEnabled()).toBe(true);
    expect(workspaceMayUseWorkflows()).toBe(true);
    delete process.env.WORKFLOWS_ALLOWED_EMAILS;
  });
});

describe('workspaceMayUseWorkflows', () => {
  afterEach(() => delete process.env.WORKFLOWS_ENABLED);

  it('gives every workspace the same answer', () => {
    expect(workspaceMayUseWorkflows()).toBe(true);
    process.env.WORKFLOWS_ENABLED = 'false';
    expect(workspaceMayUseWorkflows()).toBe(false);
  });

  it('needs no database', () => {
    // It used to join `users` for every delivery, for every watching workspace.
    // That this is now synchronous IS the performance change — a test that
    // awaited it would hide the regression if the join came back.
    const answer: boolean = workspaceMayUseWorkflows();
    expect(typeof answer).toBe('boolean');
  });
});

describe('workflowsRefusalReason', () => {
  it('says the switch was pulled, since that is the only reason left', () => {
    expect(workflowsRefusalReason()).toMatch(/switched off/);
    expect(workflowsRefusalReason()).toMatch(/WORKFLOWS_ENABLED=false/);
  });
});
