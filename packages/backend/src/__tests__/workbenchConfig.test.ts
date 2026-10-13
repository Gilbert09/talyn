import { describe, it, expect } from 'vitest';
import {
  TomlError,
  WORKBENCH_PORT_COUNT,
  applyWorkbenchScriptOverrides,
  parseToml,
  resolveWorkbenchConfig,
  workbenchEnv,
  type WorkbenchConfig,
} from '@talyn/shared';

describe('parseToml', () => {
  it.each<[string, string, unknown]>([
    ['empty', '', {}],
    ['comments and blank lines only', '# hi\n\n   # there\n', {}],
    ['basic string', 'a = "x"', { a: 'x' }],
    ['literal string keeps backslashes', "a = 'C:\\path\\n'", { a: 'C:\\path\\n' }],
    ['escapes', 'a = "tab\\tnl\\nq\\"bs\\\\u\\u00e9U\\U0001F600"', { a: 'tab\tnl\nq"bs\\u\u00e9U\u{1F600}' }],
    ['hash inside a string is not a comment', 'a = "x # y" # real comment', { a: 'x # y' }],
    ['booleans', 'a = true\nb = false', { a: true, b: false }],
    ['integers', 'a = 42\nb = -7\nc = +3\nd = 1_000', { a: 42, b: -7, c: 3, d: 1000 }],
    ['floats', 'a = 3.14\nb = -0.5\nc = 1e3', { a: 3.14, b: -0.5, c: 1000 }],
    ['string array', 'a = ["x", "y"]', { a: ['x', 'y'] }],
    ['empty array', 'a = []', { a: [] }],
    ['multi-line array with comments and trailing comma', 'a = [\n  "x", # one\n  "y",\n  # gap\n]\n', { a: ['x', 'y'] }],
    ['nested arrays', 'a = [[1, 2], ["x"]]', { a: [[1, 2], ['x']] }],
    ['inline table', 'a = { command = "npm run dev", default = true }', { a: { command: 'npm run dev', default: true } }],
    ['empty inline table', 'a = {}', { a: {} }],
    ['table header', '[scripts]\nsetup = "x"', { scripts: { setup: 'x' } }],
    ['dotted table header', '[scripts.run.web]\ncommand = "x"', { scripts: { run: { web: { command: 'x' } } } }],
    ['quoted key in header', '[scripts.run."my web"]\ncommand = "x"', { scripts: { run: { 'my web': { command: 'x' } } } }],
    ['spaces in a dotted header', '[ scripts . run ]\nx = 1', { scripts: { run: { x: 1 } } }],
    ['dotted key', 'scripts.setup = "x"\nscripts.archive = "y"', { scripts: { setup: 'x', archive: 'y' } }],
    ['quoted keys', '"a b" = 1\n\'c.d\' = 2', { 'a b': 1, 'c.d': 2 }],
    ['bare key with dashes and digits', 'run-mode_2 = "x"', { 'run-mode_2': 'x' }],
    ['header after header reopens a sub-table of an implicit table', '[a.b]\nx = 1\n[a]\ny = 2', { a: { b: { x: 1 }, y: 2 } }],
    ['CRLF line endings', '[s]\r\na = "x"\r\nb = 1\r\n', { s: { a: 'x', b: 1 } }],
    ['multi-line basic string trims the first newline', 'a = """\nline1\nline2"""', { a: 'line1\nline2' }],
    ['multi-line basic string with escapes and quotes', 'a = """say "hi"\\tnow"""', { a: 'say "hi"\tnow' }],
    ['multi-line basic: two quotes before the end', 'a = """x"""""', { a: 'x""' }],
    ['multi-line basic: line-ending backslash', 'a = """\\\n    one \\\n    two"""', { a: 'one two' }],
    ['multi-line literal', "a = '''\nraw \\n $x\n'''", { a: 'raw \\n $x\n' }],
    [
      'a realistic script',
      '[scripts]\nsetup = """\nnpm ci\ncp $CONDUCTOR_ROOT_PATH/.env .env\n"""\n',
      { scripts: { setup: 'npm ci\ncp $CONDUCTOR_ROOT_PATH/.env .env\n' } },
    ],
  ])('%s', (_name, source, expected) => {
    expect(parseToml(source)).toEqual(expected);
  });

  it.each<[string, string, RegExp]>([
    ['unterminated string', 'a = "x', /unterminated string/],
    ['newline in a basic string', 'a = "x\ny"', /unterminated string/],
    ['unterminated literal', "a = 'x", /unterminated literal/],
    ['unterminated multi-line', 'a = """x', /unterminated multi-line/],
    ['invalid escape', 'a = "\\q"', /invalid escape/],
    ['bad unicode escape', 'a = "\\u12"', /unicode/],
    ['missing =', 'a "x"', /expected "="/],
    ['missing value', 'a =', /expected a value/],
    ['garbage value', 'a = nope', /invalid value/],
    ['junk after value', 'a = "x" y', /after value/],
    ['duplicate key', 'a = 1\na = 2', /duplicate key/],
    ['duplicate table', '[a]\n[a]', /defined twice/],
    ['table over a value', 'a = 1\n[a]', /already defined as a value/],
    ['dotted key through a value', 'a = 1\na.b = 2', /already defined as a value/],
    ['extending an inline table', 'a = { b = 1 }\n[a.c]', /already defined as a value/],
    ['array of tables', '[[a]]', /not supported/],
    ['dates', 'a = 2026-10-13', /not supported/],
    ['unclosed header', '[a\nb = 1', /close table header/],
    ['unclosed array', 'a = [1, 2', /expected "," or "\]"/],
    ['leading zero', 'a = 007', /invalid value/],
  ])('refuses %s', (_name, source, message) => {
    expect(() => parseToml(source)).toThrow(TomlError);
    expect(() => parseToml(source)).toThrow(message);
  });

  it('reports the line number', () => {
    try {
      parseToml('a = 1\n\n# c\nb = nope');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TomlError);
      expect((err as TomlError).line).toBe(4);
      expect((err as Error).message).toMatch(/^line 4:/);
    }
  });
});

describe('resolveWorkbenchConfig', () => {
  const none: WorkbenchConfig = { run: [], runMode: 'concurrent', filesToCopy: [], source: 'none', errors: [] };

  it.each<[string, Parameters<typeof resolveWorkbenchConfig>[0], Partial<WorkbenchConfig>]>([
    ['no files', {}, none],
    ['blank files count as absent', { talynToml: '  \n', conductorJson: '', conductorToml: null }, none],
    [
      'conductor TOML, simple',
      { conductorToml: '[scripts]\nsetup = "npm ci"\nrun = "npm run dev"\narchive = "rm -rf tmp"\nrun_mode = "nonconcurrent"\n' },
      {
        setup: { command: 'npm ci' },
        run: [{ name: 'run', command: 'npm run dev', default: true }],
        archive: { command: 'rm -rf tmp' },
        runMode: 'nonconcurrent',
        source: 'conductor-toml',
      },
    ],
    [
      'conductor TOML, named run scripts with a default',
      {
        conductorToml: [
          '[scripts.run.api]',
          'command = "npm run api"',
          '',
          '[scripts.run.web]',
          'command = "npm run web"',
          'default = true',
        ].join('\n'),
      },
      {
        run: [
          { name: 'api', command: 'npm run api', default: false },
          { name: 'web', command: 'npm run web', default: true },
        ],
        source: 'conductor-toml',
      },
    ],
    [
      'named run scripts with no default: the first',
      { conductorToml: '[scripts.run]\nweb = "a"\napi = "b"' },
      { run: [{ name: 'web', command: 'a', default: true }, { name: 'api', command: 'b', default: false }] },
    ],
    [
      'two defaults: only the first stays default',
      { conductorToml: '[scripts.run]\nweb = { command = "a", default = true }\napi = { command = "b", default = true }' },
      { run: [{ name: 'web', command: 'a', default: true }, { name: 'api', command: 'b', default: false }] },
    ],
    [
      'run as a single { command } table',
      { conductorToml: '[scripts.run]\ncommand = "npm start"' },
      { run: [{ name: 'run', command: 'npm start', default: true }] },
    ],
    [
      'run_mode at top level, spelled with a dash',
      { conductorToml: 'run_mode = "non-concurrent"\n[scripts]\nrun = "x"' },
      { runMode: 'nonconcurrent' },
    ],
    ['unknown run_mode is concurrent', { conductorToml: 'run_mode = "sometimes"' }, { runMode: 'concurrent' }],
    ['blank scripts are absent', { conductorToml: '[scripts]\nsetup = ""\nrun = "  "' }, { setup: undefined, run: [] }],
    ['files to copy', { talynToml: 'files_to_copy = [".env", ".env.local", 3]' }, { filesToCopy: ['.env', '.env.local'], source: 'talyn' }],
    [
      'conductor.json',
      { conductorJson: JSON.stringify({ scripts: { setup: 'npm ci', run: 'npm run dev', archive: 'echo bye' }, runScriptMode: 'nonconcurrent' }) },
      {
        setup: { command: 'npm ci' },
        run: [{ name: 'run', command: 'npm run dev', default: true }],
        archive: { command: 'echo bye' },
        runMode: 'nonconcurrent',
        source: 'conductor-json',
      },
    ],
    ['conductor.json with no scripts', { conductorJson: '{}' }, { run: [], source: 'conductor-json' }],
  ])('%s', (_name, files, expected) => {
    expect(resolveWorkbenchConfig(files)).toMatchObject(expected);
  });

  const talyn = '[scripts]\nsetup = "talyn"';
  const json = JSON.stringify({ scripts: { setup: 'json' } });
  const toml = '[scripts]\nsetup = "conductor"';

  it.each<[string, Parameters<typeof resolveWorkbenchConfig>[0], string, string]>([
    ['talyn wins over both', { talynToml: talyn, conductorJson: json, conductorToml: toml }, 'talyn', 'talyn'],
    ['conductor.json wins over .conductor/settings.toml', { conductorJson: json, conductorToml: toml }, 'json', 'conductor-json'],
    ['.conductor/settings.toml alone', { conductorToml: toml }, 'conductor', 'conductor-toml'],
    ['talyn wins over toml', { talynToml: talyn, conductorToml: toml }, 'talyn', 'talyn'],
  ])('precedence: %s', (_name, files, setup, source) => {
    const config = resolveWorkbenchConfig(files);
    expect(config.setup?.command).toBe(setup);
    expect(config.source).toBe(source);
    expect(config.errors).toEqual([]);
  });

  it('skips a broken file, uses the next, and reports why', () => {
    const config = resolveWorkbenchConfig({ talynToml: '[scripts\nsetup = 1', conductorJson: '{not json', conductorToml: toml });
    expect(config.source).toBe('conductor-toml');
    expect(config.setup?.command).toBe('conductor');
    expect(config.errors).toHaveLength(2);
    expect(config.errors[0]).toMatch(/^\.talyn\/settings\.toml: line 1:/);
    expect(config.errors[1]).toMatch(/^conductor\.json: /);
  });

  it('reports a non-object conductor.json', () => {
    const config = resolveWorkbenchConfig({ conductorJson: '[1,2]' });
    expect(config.source).toBe('none');
    expect(config.errors[0]).toMatch(/must be a JSON object/);
  });
});

describe('applyWorkbenchScriptOverrides', () => {
  const base = resolveWorkbenchConfig({
    conductorToml: '[scripts]\nsetup = "npm ci"\narchive = "bye"\n[scripts.run]\nweb = "npm run web"',
  });

  it.each<[string, Parameters<typeof applyWorkbenchScriptOverrides>[1], Partial<WorkbenchConfig>]>([
    ['no settings', null, { setup: { command: 'npm ci' }, archive: { command: 'bye' } }],
    ['absent keys keep the file', { scripts: {} }, { setup: { command: 'npm ci' } }],
    ['string replaces', { scripts: { setup: 'pnpm i' } }, { setup: { command: 'pnpm i' } }],
    ['null removes', { scripts: { archive: null } }, { archive: undefined }],
    ['blank removes', { scripts: { setup: '  ' } }, { setup: undefined }],
    ['run string replaces named scripts', { scripts: { run: 'make dev' } }, { run: [{ name: 'run', command: 'make dev', default: true }] }],
    ['run null clears', { scripts: { run: null } }, { run: [] }],
    [
      'run list is normalised',
      { scripts: { run: [{ name: 'a', command: 'x', default: false }, { name: 'b', command: ' ', default: true }, { name: 'c', command: 'z', default: false }] } },
      { run: [{ name: 'a', command: 'x', default: true }, { name: 'c', command: 'z', default: false }] },
    ],
    ['run mode', { scripts: { runMode: 'nonconcurrent' } }, { runMode: 'nonconcurrent' }],
    ['prompts only', { prompts: { create_pr: 'x' } }, { setup: { command: 'npm ci' } }],
  ])('%s', (_name, settings, expected) => {
    expect(applyWorkbenchScriptOverrides(base, settings)).toMatchObject(expected);
  });

  it('does not mutate the input', () => {
    const copy = JSON.parse(JSON.stringify(base));
    applyWorkbenchScriptOverrides(base, { scripts: { setup: 'x', run: null } });
    expect(base).toEqual(copy);
  });
});

describe('workbenchEnv', () => {
  it('sets the Talyn and Conductor names to the same values', () => {
    expect(workbenchEnv({ workbenchPath: '/w/tokyo', rootPath: '/repo', name: 'tokyo', port: 41000 })).toEqual({
      TALYN_WORKBENCH_PATH: '/w/tokyo',
      TALYN_WORKBENCH_NAME: 'tokyo',
      TALYN_ROOT_PATH: '/repo',
      TALYN_PORT: '41000',
      CONDUCTOR_WORKSPACE_PATH: '/w/tokyo',
      CONDUCTOR_WORKSPACE_NAME: 'tokyo',
      CONDUCTOR_ROOT_PATH: '/repo',
      CONDUCTOR_PORT: '41000',
    });
  });

  it('adds the default branch when given', () => {
    const env = workbenchEnv({ workbenchPath: '/w', rootPath: '/r', name: 'n', port: 1, defaultBranch: 'main' });
    expect(env.TALYN_DEFAULT_BRANCH).toBe('main');
    expect(env.CONDUCTOR_DEFAULT_BRANCH).toBe('main');
  });

  it('reserves ten ports', () => {
    expect(WORKBENCH_PORT_COUNT).toBe(10);
  });
});
