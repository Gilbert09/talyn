import { execSync } from 'child_process';
import fs from 'fs';
import { dependencies } from '../../release/app/package.json';
import webpackPaths from '../configs/webpack.paths';

if (
  Object.keys(dependencies || {}).length > 0 &&
  fs.existsSync(webpackPaths.appNodeModulesPath)
) {
  // npm workspaces hoist @electron/rebuild to the repo root, so resolve it
  // rather than assume apps/desktop/node_modules/.bin.
  const cli = require.resolve('@electron/rebuild/lib/cli.js');
  const cmd = `"${process.execPath}" "${cli}" --force --types prod,dev,optional --module-dir .`;
  execSync(cmd, {
    cwd: webpackPaths.appPath,
    stdio: 'inherit',
  });
}
