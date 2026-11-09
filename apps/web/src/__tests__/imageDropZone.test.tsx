import { vi, it, expect, afterEach, describe } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { ImageDropOverlay, useImageDropZone } from '../components/workbench/useComposerImages';
import { toast } from '../stores/toast';

function Zone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const { dragging, dropProps } = useImageDropZone(onFiles);
  return (
    <div>
      <div data-testid="zone" {...dropProps}>
        <ImageDropOverlay dragging={dragging} />
        <textarea aria-label="Message" />
      </div>
      <div data-testid="outside" />
    </div>
  );
}

const png = new File(['a'], 'shot.png', { type: 'image/png' });
const jpg = new File(['b'], 'photo.jpg', { type: 'image/jpeg' });
const pdf = new File(['c'], 'notes.pdf', { type: 'application/pdf' });

const fileDrag = (files: File[] = [png]) => ({ dataTransfer: { types: ['Files'], files, dropEffect: 'none' } });
const textDrag = { dataTransfer: { types: ['text/plain'], files: [], dropEffect: 'none' } };

const overlay = () => screen.queryByText('Drop images to attach');

function setup() {
  const onFiles = vi.fn();
  render(<Zone onFiles={onFiles} />);
  return { onFiles, zone: screen.getByTestId('zone'), textarea: screen.getByRole('textbox', { name: 'Message' }) };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useImageDropZone', () => {
  it('shows the overlay while files are dragged over the zone', () => {
    const { zone } = setup();
    expect(overlay()).not.toBeInTheDocument();
    fireEvent.dragEnter(zone, fileDrag());
    expect(overlay()).toBeInTheDocument();
    fireEvent.dragLeave(zone, fileDrag());
    expect(overlay()).not.toBeInTheDocument();
  });

  it('keeps the overlay while the drag moves between child elements', () => {
    const { zone, textarea } = setup();
    fireEvent.dragEnter(zone, fileDrag());
    fireEvent.dragEnter(textarea, fileDrag());
    fireEvent.dragLeave(zone, fileDrag());
    expect(overlay()).toBeInTheDocument();
    fireEvent.dragLeave(textarea, fileDrag());
    expect(overlay()).not.toBeInTheDocument();
  });

  it('accepts the drag with a copy effect', () => {
    const { zone } = setup();
    const dragOver = createEvent.dragOver(zone, fileDrag());
    fireEvent(zone, dragOver);
    expect(dragOver.defaultPrevented).toBe(true);
    expect((dragOver as DragEvent).dataTransfer?.dropEffect).toBe('copy');
  });

  it.each([
    ['on the zone', 'zone'],
    ['on the textarea', 'textarea'],
  ])('attaches only the images dropped %s', (_label, target) => {
    const { onFiles, zone, textarea } = setup();
    const element = target === 'zone' ? zone : textarea;
    fireEvent.dragEnter(element, fileDrag([png, pdf, jpg]));
    expect(fireEvent.drop(element, fileDrag([png, pdf, jpg]))).toBe(false);
    expect(onFiles).toHaveBeenCalledWith([png, jpg]);
    expect(overlay()).not.toBeInTheDocument();
  });

  it('tells the person when no dropped file is an image', () => {
    const error = vi.spyOn(toast, 'error');
    const { onFiles, zone } = setup();
    fireEvent.drop(zone, fileDrag([pdf]));
    expect(onFiles).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('Could not attach the file', 'Only images can be attached.');
  });

  it('ignores drags that carry no files', () => {
    const error = vi.spyOn(toast, 'error');
    const { onFiles, textarea } = setup();
    fireEvent.dragEnter(textarea, textDrag);
    expect(overlay()).not.toBeInTheDocument();
    expect(fireEvent.dragOver(textarea, textDrag)).toBe(true);
    expect(fireEvent.drop(textarea, textDrag)).toBe(true);
    expect(onFiles).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('stops a file dropped outside the zone from opening in the window', () => {
    setup();
    const outside = screen.getByTestId('outside');
    const dragOver = createEvent.dragOver(outside, { dataTransfer: { types: ['Files'], files: [png], dropEffect: 'copy' } });
    fireEvent(outside, dragOver);
    expect(dragOver.defaultPrevented).toBe(true);
    expect((dragOver as DragEvent).dataTransfer?.dropEffect).toBe('none');
    expect(fireEvent.drop(outside, fileDrag())).toBe(false);
    expect(fireEvent.drop(outside, textDrag)).toBe(true);
  });

  it('clears the overlay when the drag ends outside the zone', () => {
    const { zone } = setup();
    fireEvent.dragEnter(zone, fileDrag());
    fireEvent.dragEnd(window);
    expect(overlay()).not.toBeInTheDocument();
  });
});
