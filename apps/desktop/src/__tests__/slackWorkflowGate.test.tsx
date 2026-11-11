import '@testing-library/jest-dom';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { api } from '../renderer/lib/api';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { IntegrationsView } from '../renderer/pages/IntegrationsView';

afterEach(() => { cleanup(); jest.restoreAllMocks(); });

describe('Slack automations gate', () => {
  it('hides the automations section when slackChannelRules is false', () => {
    useWorkspaceStore.setState({
      currentWorkspaceId: 'ws1',
      features: { workbenches: true, workflows: true, slackChannelRules: false },
    } as never);
    jest.spyOn(api.slack, 'getStatus').mockResolvedValue({ installations: [], links: [] });
    render(<IntegrationsView kind="slack" />);
    expect(screen.queryByRole('tab', { name: 'Automations' })).toBeNull();
    expect(screen.queryByText('Slack automations')).toBeNull();
  });
});
