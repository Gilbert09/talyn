// Builds the compact file-icon lookup data both apps ship from the
// material-icon-theme manifest. Run after bumping the package:
//   node scripts/generate-file-icon-data.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'apps/web/package.json'));
const pkgDir = dirname(require.resolve('material-icon-theme/package.json'));
const manifest = JSON.parse(readFileSync(join(pkgDir, 'dist/material-icons.json'), 'utf8'));

const iconFile = (defName) => {
  const def = manifest.iconDefinitions[defName];
  if (!def) throw new Error(`no definition for ${defName}`);
  const file = basename(def.iconPath, '.svg');
  if (!existsSync(join(pkgDir, 'icons', `${file}.svg`))) throw new Error(`missing icon ${file}`);
  return file;
};
// Keys with a slash are path patterns, which a bare entry name can never match.
const mapValues = (obj = {}) =>
  Object.fromEntries(
    Object.entries(obj)
      .filter(([k]) => !k.includes('/'))
      .map(([k, v]) => [k.toLowerCase(), iconFile(v)])
  );

// The open variant is `<closed>-open` almost always, so only the exceptions are stored.
const openExceptions = (closed, open) => {
  const out = {};
  for (const [name, icon] of Object.entries(closed)) {
    const expected = `${icon}-open`;
    if (open[name] === expected && existsSync(join(pkgDir, 'icons', `${expected}.svg`))) continue;
    if (!open[name]) throw new Error(`no open icon for folder ${name}`);
    out[name] = open[name];
  }
  return out;
};

const light = manifest.light ?? {};
const folderNames = mapValues(manifest.folderNames);
const lightFolderNames = mapValues(light.folderNames);
const data = {
  file: iconFile(manifest.file),
  folder: iconFile(manifest.folder),
  folderOpen: iconFile(manifest.folderExpanded),
  fileNames: mapValues(manifest.fileNames),
  fileExtensions: mapValues(manifest.fileExtensions),
  folderNames,
  folderNamesOpen: openExceptions(folderNames, mapValues(manifest.folderNamesExpanded)),
  light: {
    fileNames: mapValues(light.fileNames),
    fileExtensions: mapValues(light.fileExtensions),
    folderNames: lightFolderNames,
    folderNamesOpen: openExceptions(lightFolderNames, mapValues(light.folderNamesExpanded)),
  },
};

const out = JSON.stringify(data);
for (const target of ['apps/desktop/src/renderer/lib/fileIconData.json', 'apps/web/src/lib/fileIconData.json']) {
  writeFileSync(join(root, target), out);
}
console.log(`wrote ${out.length} bytes`);
