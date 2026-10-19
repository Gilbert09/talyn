import { followsPrereleases } from '../main/updater';

/**
 * A stable build that follows pre-releases installs ANY newer pre-release,
 * a branch build included (electron-updater takes the newest entry in the
 * feed). Only a pre-release build may follow them, and electron-updater then
 * keeps it on releases with its own name.
 */
describe('followsPrereleases', () => {
  it.each<[string, boolean]>([
    ['0.3.31', false],
    ['1.0.0', false],
    ['dev', false],
    ['0.1.0', false],
    ['0.3.31-workbenches.12', true],
    ['1.0.0-beta.1', true],
    ['0.3.31-', false],
  ])('%s → %s', (version, expected) => {
    expect(followsPrereleases(version)).toBe(expected);
  });
});
