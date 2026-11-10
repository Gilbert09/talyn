import { prMatchesText } from '../renderer/components/panels/github/filters';

describe('prMatchesText', () => {
  const target = { owner: 'Example', repo: 'Project', number: 123, summary: { title: 'Fix the Login flow' } };
  it.each([
    ['login', true],
    ['example/project#123', true],
    ['#12', true],
    ['12', true],
    ['other', false],
    ['https://github.com/example/project/pull/123', true],
    ['https://github.com/example/project/pull/123/files', true],
    ['https://github.com/example/project/pull/123#discussion_r1', true],
    ['github.com/example/project/pull/123', true],
    ['https://github.com/example/project/pull/12', false],
    ['https://github.com/example/project/pull/1234', false],
    ['https://github.com/example/other/pull/123', false],
    ['https://github.com/other/project/pull/123', false],
  ])('matches %j: %s', (q, expected) => {
    expect(prMatchesText(target, q)).toBe(expected);
  });
});
