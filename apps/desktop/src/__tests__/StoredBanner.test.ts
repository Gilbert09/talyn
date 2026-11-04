import { staleText } from '../renderer/components/workbench/StoredBanner';

describe('staleText', () => {
  it.each([
    ['list_newer', 'This copy is out of date: the session has newer changes.'],
    ['sandbox_replaced', 'This copy is from an earlier sandbox.'],
    [undefined, null],
  ] as const)('returns the message for %s', (stale, expected) => {
    expect(staleText(stale)).toBe(expected);
  });
});
