import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { ShortcutsSettings, shortcutRows } from '../components/settings/sections/ShortcutsSettings';
import { buildAppShortcuts } from '../components/layout/appShortcuts';

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

describe("Settings → Shortcuts go-to", () => {
  it('lists the go-to sequences in their own group and Tab under Session', () => {
    const groups = shortcutRows(buildAppShortcuts());
    const goTo = groups.find((g) => g.group === 'Go to');
    expect(goTo?.rows.map((r) => [r.label, r.keys])).toEqual([
      ['Go to Home', 'G then H'],
      ['Go to History', 'G then Y'],
      ['Go to Pull requests', 'G then P'],
      ['Go to Review requests', 'G then R'],
      ['Go to Code review', 'G then C'],
      ['Go to Merge queue', 'G then M'],
      ['Go to Tasks', 'G then T'],
      ['Go to Integrations', 'G then N'],
      ['Go to Insights', 'G then I'],
      ['Go to Settings', 'G then S'],
    ]);
    const session = groups.find((g) => g.group === 'Session');
    expect(session?.rows).toContainEqual({ id: 'composer.focus.tab', label: 'Focus chat input', keys: 'Tab' });
    const general = groups.find((g) => g.group === 'General');
    expect(general?.rows.map((r) => r.label)).toContain('Show keyboard shortcuts');
  });

  it('every go-to sequence has its own keys', () => {
    const keys = buildAppShortcuts().map((s) => s.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('renders the go-to group with both keys', () => {
    render(<ShortcutsSettings />);
    expect(screen.getByText('Go to')).toBeInTheDocument();
    const row = screen.getByText('Go to Review requests').parentElement?.parentElement as HTMLElement;
    expect(within(row).getByText('G')).toBeInTheDocument();
    expect(within(row).getByText('then')).toBeInTheDocument();
    expect(within(row).getByText('R')).toBeInTheDocument();
    expect(screen.getByText('Focus chat input')).toBeInTheDocument();
  });
});
