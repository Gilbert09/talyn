import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { type Workbench } from '@talyn/shared';
import { isStarting, StartingHint } from '../components/workbench/WorkbenchStarting';
import { sandboxUnavailableReason } from '../lib/workbenchOps';

vi.mock('../lib/api', () => ({ api: {} }));
vi.mock('../stores/toast', () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

const moving = { id: 'wb', runtime: 'sandbox', status: 'moving', sandboxState: 'running', statusMessage: null } as unknown as Workbench;

describe('a session moving to a fresh sandbox', () => {
  afterEach(cleanup);

  it('keeps the same controls available as a ready session', () => {
    expect(sandboxUnavailableReason(moving)).toBeNull();
  });

  it('shows no starting hint during a sandbox refresh', () => {
    expect(isStarting(moving)).toBe(false);
    const { container } = render(isStarting(moving) ? <StartingHint workbench={moving} queued={1} /> : null);
    expect(container.textContent).toBe('');
  });
});
