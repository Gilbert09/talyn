import { describe, it, expect } from 'vitest';
import { workflowsOffered } from '@talyn/shared';
import { PANEL_PATHS, panelForPath } from '../lib/routes';

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

describe('the Workflows URL', () => {
  it('has a path, so the panel is reachable and shareable', () => {
    expect(PANEL_PATHS.workflows).toBe('/workflows');
    expect(panelForPath('/workflows')).toBe('workflows');
  });
});
