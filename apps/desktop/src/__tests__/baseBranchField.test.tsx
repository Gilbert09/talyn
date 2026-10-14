/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { BaseBranchField } from '../renderer/components/workbench/new/NewWorkbenchControls';

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <BaseBranchField value={value} onChange={setValue} placeholder="main" suggestions={['main', 'develop', 'release']} />;
}

const field = () => screen.getByRole('combobox', { name: 'Base branch' });

describe('BaseBranchField', () => {
  it('opens on a click and closes on a second click', () => {
    render(<Harness />);
    fireEvent.click(field());
    expect(field()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('option')).toHaveLength(3);
    fireEvent.click(field());
    expect(field()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows every branch on a click, even when one is chosen', () => {
    render(<Harness initial="main" />);
    fireEvent.click(field());
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('filters while typing, and a pick sets the value and closes', () => {
    render(<Harness />);
    fireEvent.change(field(), { target: { value: 'dev' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['develop']);
    fireEvent.click(screen.getByRole('button', { name: 'develop' }));
    expect(field()).toHaveValue('develop');
    expect(field()).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps a branch that is not in the list', () => {
    render(<Harness />);
    fireEvent.change(field(), { target: { value: 'feature/x' } });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(field()).toHaveValue('feature/x');
  });

  it('closes on Escape', () => {
    render(<Harness />);
    fireEvent.click(field());
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(field()).toHaveAttribute('aria-expanded', 'false');
  });
});
