import { dotfilesChoices } from '../renderer/components/settings/sections/SandboxSetupSettings';

const repos = ['tom/dotfiles', 'octo/tools', 'tom/other'];

test.each([
  { query: '', expected: ['tom/dotfiles', 'octo/tools', 'tom/other'] },
  { query: 'tools', expected: ['octo/tools'] },
  { query: 'TOM/', expected: ['tom/dotfiles', 'tom/other'] },
  { query: 'tom/DOTFILES', expected: ['tom/dotfiles'] },
  { query: 'tom/new', expected: ['Use tom/new'] },
  { query: 'tom/new/extra', expected: [] },
  { query: 'unknown', expected: [] },
])('shows choices for "$query"', ({ query, expected }) => {
  expect(dotfilesChoices(repos, query).map((choice) => choice.label)).toEqual(expected);
});
