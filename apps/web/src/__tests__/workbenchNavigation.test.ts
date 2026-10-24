import { describe, it, expect, vi, afterEach } from 'vitest';
import { navigateToWorkbench, setWorkbenchNavigator } from '../lib/workbenchNavigation';
import { useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore } from '../stores/workspace';

afterEach(() => setWorkbenchNavigator(null));

describe('navigateToWorkbench', () => {
  it('uses the installed navigator and nothing else', () => {
    const navigate = vi.fn();
    setWorkbenchNavigator(navigate);
    useWorkbenchStore.setState({ selectedWorkbenchId: null });
    navigateToWorkbench('wb1');
    expect(navigate).toHaveBeenCalledWith('wb1');
    expect(useWorkbenchStore.getState().selectedWorkbenchId).toBeNull();
  });

  it('falls back to selecting the session and showing the sessions panel', () => {
    navigateToWorkbench('wb2');
    expect(useWorkbenchStore.getState().selectedWorkbenchId).toBe('wb2');
    expect(useWorkspaceStore.getState().activePanel).toBe('workbenches');
  });
});
