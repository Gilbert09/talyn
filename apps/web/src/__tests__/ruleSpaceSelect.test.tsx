import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SpacesTeam, WorkflowAction, WorkflowIntegration } from '@talyn/shared';
import { StartSessionInput } from '../components/panels/workflows/slackFields';
import { useSpacesStore } from '../stores/spaces';
import { useWorkspaceStore } from '../stores/workspace';

vi.mock('../lib/fleetModelCatalog', () => ({ useFleetModelCatalog: () => undefined }));

afterEach(() => {
  cleanup();
  useSpacesStore.setState({ teams: null });
  useWorkspaceStore.setState({ features: null } as never);
});

const team = (id: string, spaces: Array<{ id: string; name: string }>) =>
  ({ id, name: `Team ${id}`, role: 'member', homeWorkspaceId: null, createdAt: '', spaces }) as unknown as SpacesTeam;

function setup({
  spaces = true,
  teams = [team('t1', [{ id: 'space-1', name: 'Web' }, { id: 'space-2', name: 'Data' }])],
  action = { type: 'start_session', repositoryId: null, prompt: 'Fix it' } as WorkflowAction,
  integration = 'slack' as WorkflowIntegration,
} = {}) {
  useWorkspaceStore.setState({ features: { spaces } } as never);
  useSpacesStore.setState({ teams });
  const onChange = vi.fn();
  render(<StartSessionInput action={action as never} integration={integration} onChange={onChange} />);
  return { onChange, select: () => screen.queryByRole('combobox', { name: /^Space/ }) as HTMLSelectElement | null };
}

describe('the Space picker on a start-session action', () => {
  it('lists Personal and every space, grouped by team', () => {
    const { select } = setup({ teams: [team('t1', [{ id: 'space-1', name: 'Web' }]), team('t2', [{ id: 'space-2', name: 'Data' }])] });
    const el = select()!;
    expect(el.value).toBe('');
    expect([...el.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['Team t1', 'Team t2']);
    expect([...el.options].map((o) => o.textContent)).toEqual(['Personal', 'Web', 'Data']);
  });

  it.each([
    ['picks a space', 'space-2', 'space-2'],
    ['goes back to Personal', '', undefined],
  ])('%s', (_label, value, expected) => {
    const { onChange, select } = setup({
      action: { type: 'start_session', repositoryId: null, prompt: 'Fix it', spaceId: 'space-1' } as WorkflowAction,
    });
    fireEvent.change(select()!, { target: { value } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ type: 'start_session', spaceId: expected }));
  });

  it.each([
    ['Spaces is not offered', { spaces: false }],
    ['the person is in no space', { teams: [team('t1', [])] }],
    ['the teams have not loaded', { teams: null as unknown as SpacesTeam[] }],
    ['the action starts a task', { action: { type: 'start_task', repositoryId: 'r1', prompt: 'x' } as WorkflowAction, integration: 'webhook' as WorkflowIntegration }],
  ])('is hidden when %s', (_label, over) => {
    const { select } = setup(over);
    expect(select()).toBeNull();
  });

  it('keeps a saved space that the person can no longer use', () => {
    const { select } = setup({
      teams: [],
      action: { type: 'start_session', repositoryId: null, prompt: 'x', spaceId: 'space-gone' } as WorkflowAction,
    });
    const el = select()!;
    expect(el.value).toBe('space-gone');
    expect(el.selectedOptions[0]?.textContent).toBe('A space you cannot use');
  });
});
