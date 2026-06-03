import { toast, useToastStore } from '../renderer/stores/toast';

function reset() {
  useToastStore.setState({ toasts: [] });
}

describe('toast store', () => {
  beforeEach(() => {
    reset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('adds a success toast with a title and description', () => {
    toast.success('Merged acme/widgets#1', 'Add feature');
    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      variant: 'success',
      title: 'Merged acme/widgets#1',
      description: 'Add feature',
    });
  });

  it('auto-dismisses a success toast after its TTL', () => {
    toast.success('done');
    expect(useToastStore.getState().toasts).toHaveLength(1);
    jest.advanceTimersByTime(5_000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('keeps error toasts on screen longer than success toasts', () => {
    toast.error('Could not merge', 'Pull Request is not mergeable');
    // Past the success TTL but within the error TTL.
    jest.advanceTimersByTime(5_000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    jest.advanceTimersByTime(5_000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('assigns unique ids to toasts fired in the same tick', () => {
    toast.error('a');
    toast.info('b');
    const ids = useToastStore.getState().toasts.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('can be dismissed manually before its TTL', () => {
    const id = toast.info('heads up');
    expect(useToastStore.getState().toasts).toHaveLength(1);
    toast.dismiss(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
