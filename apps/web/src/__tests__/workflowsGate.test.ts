import { describe, it, expect } from 'vitest';
import { availableWorkflowConditions, workflowsOffered } from '@talyn/shared';
import { PANEL_PATHS, isLegacyPath, panelForPath, routeForLocation, routeForPath } from '../lib/routes';

/**
 * The web fork's half of the Workflows gate.
 *
 * The editor logic itself lives in @talyn/shared and is covered once (see the
 * desktop's workflowsGate test) — what is fork-specific is the URL, because the
 * web app gives every panel a real path. That is also the gate's one extra
 * exposure here: somebody without the flag can type /workflows, so the panel
 * must be gated as well as the nav item.
 */

describe('workflowsOffered', () => {
  it('is false while the capability answer is still loading', () => {
    expect(workflowsOffered(null)).toBe(false);
  });

  it('is false when the backend says no, true when it says yes', () => {
    expect(workflowsOffered({ workflows: false })).toBe(false);
    expect(workflowsOffered({ workflows: true })).toBe(true);
  });
});

describe('conditions follow the trigger', () => {
  it('offers the event-specific condition alongside the generic filters', () => {
    // "the conditions should match the action we're on, but generic PR filters
    // should still apply" — both halves, in one assertion.
    const keys = availableWorkflowConditions(['pr_review_requested']).map((s) => s.key);
    expect(keys).toContain('target');
    expect(keys).toContain('repos');
    expect(keys).toContain('author');
    expect(availableWorkflowConditions(['pr_opened']).map((s) => s.key)).not.toContain('target');
  });
});

describe('the GitHub rules URL', () => {
  it('has a path, so the page is reachable and shareable', () => {
    expect(PANEL_PATHS.integrations).toBe('/integrations');
    expect(panelForPath('/integrations/github')).toBe('integrations');
  });

  it.each([
    ['/workflows', { view: 'integrations', kind: 'github' }],
    ['/workflows/abc', { view: 'integrations', kind: 'github' }],
    ['/loops', { view: 'integrations', kind: 'schedule' }],
    ['/loops/abc', { view: 'integrations', kind: 'schedule' }],
  ])('keeps the old address %s working', (path, route) => {
    expect(routeForPath(path)).toEqual(route);
    expect(isLegacyPath(path)).toBe(true);
  });

  it.each([
    ['/settings', '?slack=installed'],
    ['/settings/slack', '?slack=error&message=x'],
  ])('sends the old Slack callback %s%s to the Slack page', (path, search) => {
    expect(routeForLocation(path, search)).toEqual({ view: 'integrations', kind: 'slack' });
  });

  it('does not treat a plain settings address as the Slack callback', () => {
    expect(routeForLocation('/settings', '')).toEqual({ view: 'settings', section: 'workspace' });
  });

  it('refuses an unknown integration', () => {
    expect(routeForPath('/integrations/nope')).toBeNull();
  });
});
