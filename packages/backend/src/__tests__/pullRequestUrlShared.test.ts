import { describe, expect, it } from 'vitest';
import { parsePullRequestUrl } from '@talyn/shared';

describe('parsePullRequestUrl', () => {
  it.each([
    ['https://github.com/acme/app/pull/7', { owner: 'acme', repo: 'app', number: 7 }],
    ['  https://github.com/acme/app/pull/7  ', { owner: 'acme', repo: 'app', number: 7 }],
    ['https://github.com/ACME/App/pull/7/', { owner: 'ACME', repo: 'App', number: 7 }],
    ['http://github.com/acme/app/pull/7', { owner: 'acme', repo: 'app', number: 7 }],
    ['https://www.github.com/acme/app/pull/7', { owner: 'acme', repo: 'app', number: 7 }],
    ['github.com/acme/app/pull/7', { owner: 'acme', repo: 'app', number: 7 }],
    ['HTTPS://GITHUB.COM/acme/app/pull/7', { owner: 'acme', repo: 'app', number: 7 }],
    ['https://github.com/acme/app/pull/7/files', { owner: 'acme', repo: 'app', number: 7 }],
    ['https://github.com/acme/app/pull/7/commits/abc123', { owner: 'acme', repo: 'app', number: 7 }],
    ['https://github.com/acme/app/pull/7?w=1', { owner: 'acme', repo: 'app', number: 7 }],
    ['https://github.com/acme/app/pull/7#discussion_r1', { owner: 'acme', repo: 'app', number: 7 }],
    ['https://github.com/acme/my.app-2/pull/123', { owner: 'acme', repo: 'my.app-2', number: 123 }],
  ])('parses %s', (input, expected) => {
    expect(parsePullRequestUrl(input)).toEqual(expected);
  });

  it.each([
    '',
    '7',
    '#7',
    'acme/app#7',
    'https://github.com/acme/app/pull/',
    'https://github.com/acme/app/pull/abc',
    'https://github.com/acme/app/pull/0',
    'https://github.com/acme/app/pull/9007199254740992',
    'https://github.com/acme/app/pull/7x',
    'https://github.com/acme/app/pulls/7',
    'https://github.com/acme/app/issues/7',
    'https://github.com/acme/pull/7',
    'https://github.com.evil.test/acme/app/pull/7',
    'https://evilgithub.com/acme/app/pull/7',
    'https://user:pass@github.com/acme/app/pull/7',
    'ftp://github.com/acme/app/pull/7',
    'see https://github.com/acme/app/pull/7',
    'https://github.com/acme/app/pull/7 and more',
  ])('rejects %j', (input) => {
    expect(parsePullRequestUrl(input)).toBeNull();
  });
});
