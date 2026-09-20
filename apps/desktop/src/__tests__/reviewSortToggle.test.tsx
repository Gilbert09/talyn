import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ReviewSortToggle, sortDirForMode, type ReviewSortMode } from '../renderer/components/panels/github/filters';

afterEach(cleanup);

/** Render the control and return a click-and-read-the-new-label driver. */
function mount(initial: ReviewSortMode, offerPriority: boolean) {
  const seen: ReviewSortMode[] = [];
  function Harness() {
    const [mode, setMode] = React.useState<ReviewSortMode>(initial);
    return (
      <ReviewSortToggle
        mode={mode}
        offerPriority={offerPriority}
        onChange={(next) => {
          seen.push(next);
          setMode(next);
        }}
      />
    );
  }
  render(<Harness />);
  const button = () => screen.getByRole('button');
  return { seen, button, click: () => fireEvent.click(button()) };
}

describe('ReviewSortToggle', () => {
  it('cycles newest → oldest → priority → newest when the flag is on', () => {
    const t = mount('newest', true);
    expect(t.button()).toHaveTextContent('Newest');
    t.click();
    expect(t.button()).toHaveTextContent('Oldest');
    t.click();
    expect(t.button()).toHaveTextContent('Priority');
    t.click();
    expect(t.button()).toHaveTextContent('Newest');
    expect(t.seen).toEqual(['oldest', 'priority', 'newest']);
  });

  it('has exactly two states when the flag is off', () => {
    // A user outside the audience must see no trace of the third — not a
    // disabled segment, not a greyed label.
    const t = mount('newest', false);
    t.click();
    expect(t.button()).toHaveTextContent('Oldest');
    t.click();
    expect(t.button()).toHaveTextContent('Newest');
    expect(t.seen).toEqual(['oldest', 'newest']);
    expect(t.seen).not.toContain('priority');
  });

  it('falls back to Newest when a stored Priority outlives the flag', () => {
    // localStorage keeps the mode, so taking the flag away must not leave the
    // control rendering a state its cycle no longer contains.
    const t = mount('priority', false);
    expect(t.button()).toHaveTextContent('Newest');
    t.click();
    expect(t.seen).toEqual(['oldest']);
  });

  it('explains what the next click does, in every mode', () => {
    const t = mount('newest', true);
    expect(t.button().title).toContain('oldest');
    t.click();
    expect(t.button().title).toContain('priority');
    t.click();
    expect(t.button().title).toContain('newest');
  });

  it('says the ordering is not personalized until a model is serving', () => {
    render(<ReviewSortToggle mode="priority" offerPriority onChange={() => {}} />);
    expect(screen.getByRole('button').title).toContain("each PR's current state");

    cleanup();
    render(
      <ReviewSortToggle mode="priority" offerPriority modelInstalled onChange={() => {}} />
    );
    expect(screen.getByRole('button').title).toContain('your own review history');
  });
});

describe('sortDirForMode', () => {
  it('maps the two date modes onto the existing comparator', () => {
    expect(sortDirForMode('newest')).toBe('desc');
    expect(sortDirForMode('oldest')).toBe('asc');
  });

  it('never reaches for priority, which has its own comparator', () => {
    // Defensive: if this ever changed to 'asc' the priority list would silently
    // fall back to oldest-first instead of failing visibly.
    expect(sortDirForMode('priority')).toBe('desc');
  });
});
