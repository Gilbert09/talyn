import { iconModuleUrl } from '../renderer/lib/fileIcons';

describe('iconModuleUrl', () => {
  it.each([
    ['a plain URL string, as webpack asset/resource exports it', './a9e40cba.svg', './a9e40cba.svg'],
    ['an ES module with a default URL', { default: './b.svg' }, './b.svg'],
    ['an ES module with no default', {}, null],
    ['an empty string', '', null],
  ])('reads %s', (_label, input, expected) => {
    expect(iconModuleUrl(input as Parameters<typeof iconModuleUrl>[0])).toBe(expected);
  });
});
