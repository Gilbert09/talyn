import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenSession } from '../routes/OpenSession';

function Location() {
  return <output>{useLocation().pathname}</output>;
}

afterEach(() => vi.useRealTimers());

describe('OpenSession', () => {
  it('opens the desktop app, then falls back to the browser route', () => {
    vi.useFakeTimers();
    const openApp = vi.fn();
    render(
      <MemoryRouter initialEntries={['/open/session/session-1']}>
        <Routes>
          <Route path="/open/session/:id" element={<OpenSession openApp={openApp} />} />
          <Route path="/s/:id" element={<Location />} />
        </Routes>
      </MemoryRouter>
    );

    expect(openApp).toHaveBeenCalledWith('fastowl://session/session-1');
    expect(screen.getByRole('link', { name: 'open this session in your browser' }).getAttribute('href')).toBe(
      '/s/session-1'
    );
    act(() => vi.advanceTimersByTime(1_500));
    expect(screen.getByText('/s/session-1')).toBeTruthy();
  });
});
