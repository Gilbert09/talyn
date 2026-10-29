import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { InstructionsPage } from '../renderer/components/settings/InstructionsPage';

let mockFeatures: { workbenches?: boolean } | null = { workbenches: true };
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) => selector({ features: mockFeatures }),
}));
jest.mock('../renderer/components/settings/InstructionFilesSection', () => ({
  InstructionFilesSection: () => <div>Your instructions section</div>,
}));
jest.mock('../renderer/components/settings/RepositoryInstructionsSection', () => ({
  RepositoryInstructionsSection: () => <div>Repository instructions section</div>,
}));
jest.mock('../renderer/components/panels/InstructionsSettings', () => ({
  InstructionsSettings: () => <div>Prompt templates</div>,
}));

afterEach(cleanup);

describe('Instructions settings page', () => {
  it('draws your instructions and repository instructions above the prompt templates', () => {
    mockFeatures = { workbenches: true };
    render(<InstructionsPage />);
    const text = document.body.textContent ?? '';
    const order = ['Your instructions section', 'Repository instructions section', 'Prompt templates'].map((t) => text.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('leaves the session sections out when sessions are not offered', () => {
    mockFeatures = { workbenches: false };
    render(<InstructionsPage />);
    expect(screen.queryByText('Your instructions section')).toBeNull();
    expect(screen.queryByText('Repository instructions section')).toBeNull();
    expect(screen.getByText('Prompt templates')).toBeInTheDocument();
  });
});
