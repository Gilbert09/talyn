import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ShortcutsSettings } from '../components/settings/sections/ShortcutsSettings';

afterEach(cleanup);

it('shows the web key table and groups session jumps', () => {
  render(<ShortcutsSettings />);
  expect(screen.getByText('New Session')).toBeTruthy();
  expect(screen.getByText('Open session 1–9')).toBeTruthy();
  expect(screen.queryByText('Back')).toBeNull();
  expect(screen.getByText('Focus Composer')).toBeTruthy();
});
