import { describe, it, expect, beforeEach } from 'vitest';
import type { PRRow } from '../lib/api';
import type { SkillSummary } from '@talyn/shared';

import { useWorkspaceStore } from '../stores/workspace';

const row = { id: 'pr1', owner: 'acme', repo: 'w', number: 7 } as unknown as PRRow;
const skill: SkillSummary = { key: 'platform:1', source: 'platform', name: 'pr-review', description: '', id: '1' };

describe('workspace store — connect-agent modal state', () => {
  beforeEach(() => {
    useWorkspaceStore.getState().closeConnectAgent();
  });

  it('is closed with no pending task by default', () => {
    const s = useWorkspaceStore.getState();
    expect(s.connectAgentOpen).toBe(false);
    expect(s.pendingCloudTask).toBeNull();
  });

  it('openConnectAgent opens the modal and stashes a fix intent', () => {
    useWorkspaceStore.getState().openConnectAgent({ kind: 'fix', row, providerType: 'selfhosted' });
    const s = useWorkspaceStore.getState();
    expect(s.connectAgentOpen).toBe(true);
    expect(s.pendingCloudTask).toEqual({ kind: 'fix', row, providerType: 'selfhosted' });
  });

  it('openConnectAgent stashes a skill intent with its content', () => {
    useWorkspaceStore.getState().openConnectAgent({ kind: 'skill', row, skill, localContent: 'body' });
    expect(useWorkspaceStore.getState().pendingCloudTask).toEqual({
      kind: 'skill',
      row,
      skill,
      localContent: 'body',
    });
  });

  it('openConnectAgent with no argument opens without a pending task', () => {
    useWorkspaceStore.getState().openConnectAgent();
    const s = useWorkspaceStore.getState();
    expect(s.connectAgentOpen).toBe(true);
    expect(s.pendingCloudTask).toBeNull();
  });

  // The surface that asked is read as a breakdown in the connect funnel, so a
  // missing value has to be a NAMED bucket rather than an absent property —
  // otherwise "asked from somewhere we forgot to label" silently leaves the
  // denominator.
  it('records the surface that opened it', () => {
    useWorkspaceStore.getState().openConnectAgent({ kind: 'fix', row }, 'pr_detail_banner');
    expect(useWorkspaceStore.getState().connectAgentSource).toBe('pr_detail_banner');
  });

  it('defaults the surface to "unknown" rather than null', () => {
    useWorkspaceStore.getState().openConnectAgent({ kind: 'fix', row });
    expect(useWorkspaceStore.getState().connectAgentSource).toBe('unknown');
  });

  it('closeConnectAgent clears the surface too, so the next open cannot inherit it', () => {
    useWorkspaceStore.getState().openConnectAgent({ kind: 'fix', row }, 'task_button');
    useWorkspaceStore.getState().closeConnectAgent();
    expect(useWorkspaceStore.getState().connectAgentSource).toBeNull();
  });

  it('closeConnectAgent clears both the open flag and the pending task', () => {
    useWorkspaceStore.getState().openConnectAgent({ kind: 'fix', row });
    useWorkspaceStore.getState().closeConnectAgent();
    const s = useWorkspaceStore.getState();
    expect(s.connectAgentOpen).toBe(false);
    expect(s.pendingCloudTask).toBeNull();
  });

  it('clearPendingCloudTask drops the task but leaves the modal open', () => {
    useWorkspaceStore.getState().openConnectAgent({ kind: 'fix', row });
    useWorkspaceStore.getState().clearPendingCloudTask();
    const s = useWorkspaceStore.getState();
    expect(s.connectAgentOpen).toBe(true);
    expect(s.pendingCloudTask).toBeNull();
  });
});
