import { readFileSync } from 'fs';
import path from 'path';

// The preload runs sandboxed: it can load electron and bundled local files,
// but not Node built-ins. One `import os from 'os'` stops the whole preload,
// and the app then opens on "Something went wrong" (build 0.3.32-workbenches.25).
describe('preload imports', () => {
  const source = readFileSync(path.join(__dirname, '../main/preload.ts'), 'utf8');
  const imports = [...source.matchAll(/^import\s+(type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((m) => ({
    typeOnly: Boolean(m[1]),
    from: m[2],
  }));
  const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);

  it.each(imports.filter((i) => !i.typeOnly).map((i) => i.from))('loads %s at runtime only if the sandbox allows it', (from) => {
    expect(from === 'electron' || from.startsWith('.')).toBe(true);
  });

  it('has no require of a Node built-in', () => {
    expect(requires.filter((r) => r !== 'electron' && !r.startsWith('.'))).toEqual([]);
  });
});
