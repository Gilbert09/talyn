import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ShortcutsSettings, shortcutRows } from '../components/settings/sections/ShortcutsSettings';

afterEach(cleanup);

it('shows the web key table and groups session jumps', () => {
  render(<ShortcutsSettings />);
  expect(screen.getByText('New Session')).toBeTruthy();
  expect(screen.getByText('Open session 1–9')).toBeTruthy();
  expect(screen.getByText('Back')).toBeTruthy();
  expect(screen.getByText('Focus Composer')).toBeTruthy();
});

it('lists the arrow chord and hides the bracket alias', () => {
  const rows = shortcutRows([
    { id: 'nav.back', keys: 'mod+left', label: 'Back', group: 'General', run: () => {} },
    { id: 'nav.back.bracket', keys: 'mod+[', label: 'Back', group: 'General', hidden: true, alias: true, run: () => {} },
  ]);
  expect(rows[0].rows).toEqual([{ id: 'nav.back', label: 'Back', keys: expect.stringMatching(/←$/) }]);
});
