/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render } from '@testing-library/react';
import { type Workbench } from '@talyn/shared';
import { isStarting, StartingHint } from '../renderer/components/workbench/WorkbenchStarting';
import { sandboxUnavailableReason } from '../renderer/lib/workbenchOps';

jest.mock('../renderer/lib/api', () => ({ api: {} }));
jest.mock('../renderer/stores/toast', () => ({ toast: { error: jest.fn(), info: jest.fn() } }));

const moving = { id: 'wb', runtime: 'sandbox', status: 'moving', sandboxState: 'running', statusMessage: null } as unknown as Workbench;

describe('a session moving to a fresh sandbox', () => {
  it('keeps the same controls available as a ready session', () => {
    expect(sandboxUnavailableReason(moving)).toBeNull();
  });

  it('shows no starting hint during a sandbox refresh', () => {
    expect(isStarting(moving)).toBe(false);
    const { container } = render(isStarting(moving) ? <StartingHint workbench={moving} queued={1} /> : null);
    expect(container.textContent).toBe('');
  });
});
