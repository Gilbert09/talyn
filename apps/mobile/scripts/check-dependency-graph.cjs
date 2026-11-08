const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const expected = { react: '19.3.0', 'react-dom': '19.3.0', 'react-native': '0.88.1' };

for (const [name, version] of Object.entries(expected)) {
  const entries = Object.entries(lock.packages).filter(([location]) => location.endsWith(`/node_modules/${name}`)
    || location === `node_modules/${name}`);
  assert.equal(entries.length, 1, `Expected one locked installation of ${name}.`);
  const [location, entry] = entries[0];
  assert.equal(entry.version, version, `Unexpected locked version of ${name}.`);
  const installed = path.dirname(require.resolve(`${name}/package.json`));
  assert.equal(fs.realpathSync(installed), fs.realpathSync(path.join(root, location)),
    `The installed ${name} differs from the lockfile.`);
  console.log(`${name}: ${version} (${location})`);
}
