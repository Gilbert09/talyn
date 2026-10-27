import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { WORKBENCH_MOVING_MESSAGE, type Workbench } from '@talyn/shared';
import { isStarting, StartingHint } from '../components/workbench/WorkbenchStarting';
import { sandboxUnavailableReason } from '../lib/workbenchOps';

vi.mock('../lib/api', () => ({ api: {} }));
vi.mock('../stores/toast', () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

const moving = { id: 'wb', runtime: 'sandbox', status: 'moving', sandboxState: 'running', statusMessage: null } as unknown as Workbench;

describe('a session moving to a fresh sandbox', () => {
  afterEach(cleanup);

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
