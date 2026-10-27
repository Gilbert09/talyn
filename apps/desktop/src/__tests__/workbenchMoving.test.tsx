/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { WORKBENCH_MOVING_MESSAGE, type Workbench } from '@talyn/shared';
import { isStarting, StartingHint } from '../renderer/components/workbench/WorkbenchStarting';
import { sandboxUnavailableReason } from '../renderer/lib/workbenchOps';

jest.mock('../renderer/lib/api', () => ({ api: {} }));
jest.mock('../renderer/stores/toast', () => ({ toast: { error: jest.fn(), info: jest.fn() } }));

const moving = { id: 'wb', runtime: 'sandbox', status: 'moving', sandboxState: 'running', statusMessage: null } as unknown as Workbench;

describe('a session moving to a fresh sandbox', () => {
  it('says so where an action is refused', () => {
    expect(sandboxUnavailableReason(moving)).toBe(WORKBENCH_MOVING_MESSAGE);
  });

  it('shows the starting hint with the moving title, and queues a message', () => {
    expect(isStarting(moving)).toBe(true);
    render(<StartingHint workbench={moving} queued={1} />);
    expect(screen.getByText('Moving to a fresh sandbox')).toBeTruthy();
    expect(screen.getByText(/Your message is queued/)).toBeTruthy();
  });
});
