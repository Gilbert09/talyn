import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { api } from '../lib/api';
import { useWorkspaceStore } from '../stores/workspace';
import { IntegrationsView } from '../pages/IntegrationsView';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Slack rules gate', () => {
  it('hides the rules section when slackChannelRules is false', () => {
    useWorkspaceStore.setState({
      currentWorkspaceId: 'ws1',
      features: { workbenches: true, workflows: true, slackChannelRules: false },
    } as never);
    vi.spyOn(api.slack, 'getStatus').mockResolvedValue({ installations: [], links: [] });
    render(<IntegrationsView kind="slack" />);
    expect(screen.queryByRole('tab', { name: 'Rules' })).toBeNull();
    expect(screen.queryByText('Slack rules')).toBeNull();
  });
});
