import { hslTokenToHex, JSON_LANGUAGE, languageForPath, type LanguageMatchInfo } from '../renderer/lib/codeViewer';

// The registrations from monaco-editor's languages/definitions/*/register.js
// that matter here, plus the viewer's own JSON one.
const LANGUAGES: LanguageMatchInfo[] = [
  { id: 'plaintext', extensions: ['.txt'] },
  { id: 'typescript', extensions: ['.ts', '.tsx', '.cts', '.mts'] },
  { id: 'javascript', extensions: ['.js', '.es6', '.jsx', '.mjs', '.cjs'], filenames: ['jakefile'] },
  { id: 'python', extensions: ['.py', '.rpy', '.pyw', '.cpy', '.gyp', '.gypi'] },
  { id: 'go', extensions: ['.go'] },
  { id: 'rust', extensions: ['.rs', '.rlib'] },
  { id: 'markdown', extensions: ['.md', '.markdown', '.mdown', '.mkdn', '.mkd', '.mdwn', '.mdtxt', '.mdtext'] },
  { id: 'yaml', extensions: ['.yaml', '.yml'] },
  { id: 'shell', extensions: ['.sh', '.bash'] },
  { id: 'css', extensions: ['.css'] },
  { id: 'scss', extensions: ['.scss'] },
  { id: 'html', extensions: ['.html', '.htm', '.shtml', '.xhtml'] },
  { id: 'sql', extensions: ['.sql'] },
  { id: 'dockerfile', extensions: ['.dockerfile'], filenames: ['Dockerfile'] },
  { id: 'ini', extensions: ['.ini', '.properties', '.gitconfig'], filenames: ['config', '.gitattributes', '.gitconfig', '.editorconfig'] },
  { id: 'hcl', extensions: ['.tf', '.tfvars', '.hcl'] },
  { id: 'patterned', filenamePatterns: ['*.special.txt', 'conf/*.rules'] },
  JSON_LANGUAGE,
];

describe('languageForPath', () => {
  it.each([
    ['src/app.ts', 'typescript'],
    ['src/components/App.tsx', 'typescript'],
    ['vite.config.mts', 'typescript'],
    ['types/index.d.ts', 'typescript'],
    ['index.js', 'javascript'],
    ['scripts/build.mjs', 'javascript'],
    ['eslint.config.cjs', 'javascript'],
    ['src/App.jsx', 'javascript'],
    ['package.json', 'json'],
    ['tsconfig.json', 'json'],
    ['.vscode/settings.jsonc', 'json'],
    ['.babelrc', 'json'],
    ['.prettierrc', 'json'],
    ['main.py', 'python'],
    ['cmd/server/main.go', 'go'],
    ['src/lib.rs', 'rust'],
    ['README.md', 'markdown'],
    ['docs/GUIDE.MD', 'markdown'],
    ['.github/workflows/test.yml', 'yaml'],
    ['docker-compose.yaml', 'yaml'],
    ['Cargo.toml', 'plaintext'],
    ['scripts/deploy.sh', 'shell'],
    ['styles/app.css', 'css'],
    ['styles/app.module.scss', 'scss'],
    ['public/index.html', 'html'],
    ['migrations/0001_init.sql', 'sql'],
    ['Dockerfile', 'dockerfile'],
    ['docker/Dockerfile', 'dockerfile'],
    ['dockerfile', 'dockerfile'],
    ['build.dockerfile', 'dockerfile'],
    ['.editorconfig', 'ini'],
    ['.gitconfig', 'ini'],
    ['infra/main.tf', 'hcl'],
    ['notes.txt', 'plaintext'],
    ['a.special.txt', 'patterned'],
    ['conf/app.rules', 'patterned'],
    ['other/app.rules', 'plaintext'],
    ['LICENSE', 'plaintext'],
    ['Makefile', 'plaintext'],
    ['archive.zzzz', 'plaintext'],
    ['src/', 'plaintext'],
    ['', 'plaintext'],
  ])('%s is %s', (path, id) => {
    expect(languageForPath(path, LANGUAGES)).toBe(id);
  });

  it('gives plaintext when nothing is registered', () => {
    expect(languageForPath('src/app.ts', [])).toBe('plaintext');
  });

  it('prefers the longest matching extension', () => {
    const langs: LanguageMatchInfo[] = [
      { id: 'short', extensions: ['.ts'] },
      { id: 'long', extensions: ['.d.ts'] },
    ];
    expect(languageForPath('index.d.ts', langs)).toBe('long');
    expect(languageForPath('index.ts', langs)).toBe('short');
  });

  it('prefers an exact file name over an extension', () => {
    const langs: LanguageMatchInfo[] = [
      { id: 'byExtension', extensions: ['.lock'] },
      { id: 'byName', filenames: ['yarn.lock'] },
    ];
    expect(languageForPath('yarn.lock', langs)).toBe('byName');
    expect(languageForPath('Gemfile.lock', langs)).toBe('byExtension');
  });
});

describe('hslTokenToHex', () => {
  it.each([
    ['40 43% 98%', '#fcfbf8'],
    ['36 13% 12%', '#231f1b'],
    ['32 16% 11%', '#211c18'],
    ['0 0% 100%', '#ffffff'],
    ['0 0% 0%', '#000000'],
    ['0 100% 50%', '#ff0000'],
    ['120 100% 50%', '#00ff00'],
    ['240 100% 50%', '#0000ff'],
    ['360 100% 50%', '#ff0000'],
    ['  200 50% 40%  ', '#337799'],
    ['18 58% 58%', '#d27b56'],
    ['16 54% 49%', '#c05d39'],
    ['200deg 50% 40%', '#337799'],
    ['200, 50%, 40%', '#337799'],
  ])('%s is %s', (token, hex) => {
    expect(hslTokenToHex(token)).toBe(hex);
  });

  it.each([[''], ['red'], ['#ffffff'], ['40 43 98'], ['hsl(40 43% 98%)']])('%j does not parse', (token) => {
    expect(hslTokenToHex(token)).toBeNull();
  });
});
