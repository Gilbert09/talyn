import { act, render } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';

import { DISCARD_TITLE, useUnsavedGuard } from '../features/settings/editors/useUnsavedGuard';

type Blocked = (options: { data: { action: unknown }; repeat(): void }) => void;
const mockPrevent = jest.fn<void, [boolean, Blocked]>();
jest.mock('expo-router', () => ({ usePreventRemove: (prevent: boolean, callback: Blocked) => mockPrevent(prevent, callback) }));

let guard: ReturnType<typeof useUnsavedGuard> | null = null;
function Probe({ dirty, message, title }: { dirty: boolean; message?: string; title?: string }) {
  guard = useUnsavedGuard(dirty, message, title);
  return null;
}
const lastPrevent = () => mockPrevent.mock.calls[mockPrevent.mock.calls.length - 1];
const buttons = (spy: jest.SpyInstance) => spy.mock.calls[0][2] as AlertButton[];

describe('unsaved changes guard', () => {
  let alert: jest.SpyInstance;
  beforeEach(() => { alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {}); guard = null; });
  afterEach(() => alert.mockRestore());

  it.each([[true, true], [false, false]])('prevents leaving when dirty is %s', async (dirty, prevented) => {
    await render(<Probe dirty={dirty} />);
    expect(lastPrevent()[0]).toBe(prevented);
  });

  it.each([
    [undefined, undefined, DISCARD_TITLE, 'Your changes are not saved.', 'Keep editing', 'Discard'],
    ['Copy it first.', 'Leave without copying?', 'Leave without copying?', 'Copy it first.', 'Stay', 'Leave'],
  ])('asks with message %p and title %p', async (message, title, shownTitle, shownMessage, stay, go) => {
    await render(<Probe dirty message={message} title={title} />);
    lastPrevent()[1]({ data: { action: {} }, repeat: jest.fn() });
    expect(alert).toHaveBeenCalledWith(shownTitle, shownMessage, expect.any(Array));
    expect(buttons(alert).map((button) => button.text)).toEqual([stay, go]);
  });

  it('stays on the screen when the person keeps editing', async () => {
    const repeat = jest.fn();
    await render(<Probe dirty />);
    lastPrevent()[1]({ data: { action: {} }, repeat });
    expect(buttons(alert)[0].style).toBe('cancel');
    expect(repeat).not.toHaveBeenCalled();
    expect(lastPrevent()[0]).toBe(true);
  });

  it('turns the guard off, then repeats the blocked action, on discard', async () => {
    const repeat = jest.fn();
    await render(<Probe dirty />);
    lastPrevent()[1]({ data: { action: {} }, repeat });
    await act(async () => { buttons(alert)[1].onPress?.(); });
    expect(repeat).toHaveBeenCalledTimes(1);
    expect(lastPrevent()[0]).toBe(false);
  });

  it('leaves on purpose without asking', async () => {
    const go = jest.fn();
    await render(<Probe dirty />);
    await act(async () => { guard?.leave(go); });
    expect(go).toHaveBeenCalledTimes(1);
    expect(lastPrevent()[0]).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });
});
