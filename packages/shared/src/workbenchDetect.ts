export interface DetectedWorkbenchScripts {
  setup?: { command: string; reason: string };
  run?: { command: string; reason: string };
}

export function detectWorkbenchScripts(input: {
  files: string[];
  packageJson: string | null;
}): DetectedWorkbenchScripts {
  const files = new Set(input.files);
  const setup: Array<{ command: string; file: string }> = [];
  const jsRules = [
    ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile', 'pnpm'],
    ['bun.lock', 'bun install', 'bun run'],
    ['bun.lockb', 'bun install', 'bun run'],
    ['yarn.lock', 'yarn install', 'yarn'],
    ['package-lock.json', 'npm ci', 'npm run'],
    ['package.json', 'npm install', 'npm run'],
  ];
  const js = jsRules.find(([file]) => files.has(file));
  if (js) setup.push({ file: js[0], command: js[1] });
  for (const rules of [
    [['uv.lock', 'uv sync'], ['poetry.lock', 'poetry install']],
    [['Gemfile.lock', 'bundle install'], ['Gemfile', 'bundle install']],
    [['go.mod', 'go mod download']],
    [['Cargo.lock', 'cargo fetch'], ['Cargo.toml', 'cargo fetch']],
  ]) {
    const match = rules.find(([file]) => files.has(file));
    if (match) setup.push({ file: match[0], command: match[1] });
  }
  const detected: DetectedWorkbenchScripts = {};
  if (setup.length) {
    detected.setup = {
      command: setup.map((s) => s.command).join(' && '),
      reason: `from ${setup.map((s) => s.file).join(', ')}`,
    };
  }
  try {
    const parsed: unknown = JSON.parse(input.packageJson ?? 'null');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'scripts' in parsed) {
      const scripts = parsed.scripts;
      if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
        const name = ['dev', 'start'].find((key) => {
          const value = (scripts as Record<string, unknown>)[key];
          return typeof value === 'string' && value.trim() !== '';
        });
        if (name) {
          detected.run = {
            command: `${js?.[2] ?? 'npm run'} ${name}`,
            reason: `from the ${name} script in package.json`,
          };
        }
      }
    }
  } catch {
    // An invalid package file does not provide a run command.
  }
  return detected;
}

export function detectedScriptsToToml(detected: DetectedWorkbenchScripts): string {
  const lines = ['# Talyn wrote this file from the detected files.', '[scripts]'];
  for (const name of ['setup', 'run'] as const) {
    if (detected[name]) lines.push(`${name} = ${JSON.stringify(detected[name].command)}`);
  }
  return `${lines.join('\n')}\n`;
}
