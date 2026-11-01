import { describe, expect, it } from 'vitest';
import { compactCount } from '../components/layout/SidebarWorkbenchList';

describe('compactCount', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1000, '1k'],
    [1087, '1k'],
    [1150, '1.1k'],
    [9999, '9.9k'],
    [10_500, '10k'],
    [999_999, '999k'],
    [1_250_000, '1.2m'],
  ])('%p is %p', (n, text) => {
    expect(compactCount(n)).toBe(text);
  });
});
