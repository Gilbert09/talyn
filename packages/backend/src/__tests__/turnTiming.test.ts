import { describe, expect, it } from 'vitest';
import {
  classifyCommand,
  classifyToolCall,
  commandSegments,
  computeTurnTiming,
  containsSecret,
  formatDurationMs,
  redactSecrets,
  stripCommandPrefix,
  sumTurnTimings,
  type TurnToolCall,
} from '@talyn/shared';

describe('commandSegments', () => {
  it.each<[string, string[]]>([
    ['a && b || c; d', ['a', 'b', 'c', 'd']],
    ['echo "a && b"; c', ['echo "a && b"', 'c']],
    ["echo 'x; y' && z", ["echo 'x; y'", 'z']],
    ['dockerd > /tmp/d.log 2>&1 &', ['dockerd > /tmp/d.log 2>&1']],
    ['cmd &> out.log', ['cmd &> out.log']],
    ['curl -fsSL https://x | sh', ['curl -fsSL https://x | sh']],
    ['a \\\n  --flag', ['a    --flag']],
    ['one\ntwo', ['one', 'two']],
    ['', []],
  ])('%j', (command, expected) => {
    expect(commandSegments(command)).toEqual(expected);
  });
});

describe('stripCommandPrefix', () => {
  it.each<[string, string]>([
    ['sudo apt-get install jq', 'apt-get install jq'],
    ['sudo -E -u root apt install jq', 'apt install jq'],
    ['DEBIAN_FRONTEND=noninteractive apt-get install -y jq', 'apt-get install -y jq'],
    ['env FOO=1 pytest', 'pytest'],
    ['timeout 600 pnpm test', 'pnpm test'],
    ['uv run pytest -x', 'pytest -x'],
    ['poetry run pytest', 'pytest'],
    ['npx vitest run', 'vitest run'],
    ['pnpm exec jest', 'jest'],
    ['bundle exec rspec', 'rspec'],
    ['until docker info', 'docker info'],
    ['do sleep 2', 'sleep 2'],
    ['( cd web', 'cd web'],
    ['nohup dockerd', 'dockerd'],
  ])('%j -> %j', (segment, expected) => {
    expect(stripCommandPrefix(segment)).toBe(expected);
  });
});

describe('classifyCommand', () => {
  it.each<[string, string]>([
    // Tests
    ['pytest posthog/api/test/test_user.py -x', 'tests'],
    ['python -m pytest -k foo', 'tests'],
    ['uv run pytest ee/', 'tests'],
    ['cd frontend && pnpm test', 'tests'],
    ['pnpm run test:unit -- --watch=false', 'tests'],
    ['pnpm typescript:test', 'tests'],
    ['npx jest src/x.test.ts', 'tests'],
    ['npx vitest run', 'tests'],
    ['go test ./...', 'tests'],
    ['cargo test -p rust-core', 'tests'],
    ['python manage.py test posthog', 'tests'],
    ['bundle exec rspec spec/models', 'tests'],
    ['pytest x 2>&1 | tail -50', 'tests'],
    ['docker compose up -d && sleep 10 && pytest', 'tests'],
    ['for f in a b; do pytest $f; sleep 1; done', 'tests'],
    // Installs
    ['sudo apt-get update && sudo apt-get install -y libpq-dev', 'installs'],
    ['apt-get -y install jq', 'installs'],
    ['pip install -r requirements.txt', 'installs'],
    ['uv sync --frozen', 'installs'],
    ['uv pip install -e .', 'installs'],
    ['pnpm install --frozen-lockfile', 'installs'],
    ['npm ci', 'installs'],
    ['yarn', 'installs'],
    ['cargo install sqlx-cli --no-default-features --features postgres', 'installs'],
    ['cargo binstall sqlx-cli', 'installs'],
    ['rustup default stable', 'installs'],
    ['curl --proto =https -sSf https://sh.rustup.rs | sh -s -- -y', 'installs'],
    ['go install golang.org/x/tools/cmd/goimports@latest', 'installs'],
    ['brew install jq', 'installs'],
    ['bundle install', 'installs'],
    // Builds
    ['cargo build --release', 'builds'],
    ['make -j8', 'builds'],
    ['pnpm build', 'builds'],
    ['npm run build:prod', 'builds'],
    ['tsc --noEmit -p .', 'builds'],
    ['go build ./cmd/x', 'builds'],
    // Services
    ['docker compose -f docker-compose.dev.yml up -d', 'services'],
    ['docker-compose up -d db', 'services'],
    ['sudo dockerd > /tmp/dockerd.log 2>&1 &', 'services'],
    ['service postgresql start', 'services'],
    ['systemctl start redis', 'services'],
    ['docker ps', 'services'],
    // Waiting
    ['sleep 60', 'waiting'],
    ['sleep 300 && tail -50 /tmp/test.log', 'waiting'],
    ['until docker info >/dev/null 2>&1; do sleep 1; done', 'waiting'],
    ['while ! curl -s localhost:8000; do sleep 5; done', 'waiting'],
    ['for i in $(seq 1 60); do grep -q done log && break; sleep 10; done', 'waiting'],
    // Git
    ['git status', 'git'],
    ['git log --oneline | head', 'git'],
    ['gh pr view 12', 'git'],
    // Reading
    ['cat package.json', 'reading'],
    ['rg -n "foo" src', 'reading'],
    ['ls -la', 'reading'],
    ['sed -n 1,20p file.py', 'reading'],
    ['tail -f /tmp/x.log', 'reading'],
    // Other
    ['echo hi', 'other'],
    ['python script.py', 'other'],
    ['curl -s localhost:8000/health', 'other'],
    ['', 'other'],
  ])('%j is %s', (command, category) => {
    expect(classifyCommand(command)).toBe(category);
  });

  it('classifies inside bash -c', () => {
    expect(classifyCommand("bash -lc 'pnpm test'")).toBe('tests');
    expect(classifyCommand('sh -c "sleep 30"')).toBe('waiting');
  });
});

describe('classifyToolCall', () => {
  it.each<[string, string | undefined, string]>([
    ['Read', undefined, 'reading'],
    ['Grep', undefined, 'reading'],
    ['Glob', undefined, 'reading'],
    ['WebFetch', undefined, 'reading'],
    ['BashOutput', undefined, 'waiting'],
    ['Edit', undefined, 'other'],
    ['Write', undefined, 'other'],
    ['TodoWrite', undefined, 'other'],
    ['Task', undefined, 'other'],
    ['mcp__talyn__talyn_list_sessions', undefined, 'other'],
    ['Bash', 'pytest', 'tests'],
    ['Bash', undefined, 'other'],
    ['exec_command', 'cargo build', 'builds'],
  ])('%s %j is %s', (name, command, category) => {
    expect(classifyToolCall(name, command)).toBe(category);
  });
});

describe('secrets', () => {
  it.each([
    'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123',
    'curl -H "Authorization: Bearer abc" https://x',
    'export API_KEY=hello',
    'psql postgres://user:hunter2@localhost/db',
    'pip install --index-url https://me:pw@pypi.example.com/simple foo',
    'echo sk-ant-oat01-abcdefghijklmnopqrstuv',
    'mysql --password=secret',
    'AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP aws s3 ls',
    'echo aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5',
    'STRIPE=sk_live_abcdefghijklmn',
  ])('finds one in %j', (text) => {
    expect(containsSecret(text)).toBe(true);
    expect(redactSecrets(text)).toContain('***');
  });

  it.each([
    'cargo install sqlx-cli --no-default-features --features postgres',
    'export DATABASE_URL=postgres://localhost:5432/posthog',
    'git checkout 3f2a9c1d0e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49',
    'export PATH="$HOME/.cargo/bin:$PATH"',
    'pnpm install --frozen-lockfile',
    'export DEBUG=1',
    'export TOKEN_TTL=',
  ])('finds none in %j', (text) => {
    expect(containsSecret(text)).toBe(false);
    expect(redactSecrets(text)).toBe(text);
  });

  it('keeps the rest of the text when it redacts', () => {
    expect(redactSecrets('GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 gh pr list')).toBe('GITHUB_TOKEN=*** gh pr list');
    expect(redactSecrets('psql postgres://u:pw@db/x -c 1')).toBe('psql postgres://u:***@db/x -c 1');
    expect(redactSecrets('tool --token abc --verbose')).toBe('tool --token *** --verbose');
  });
});

const T0 = Date.parse('2026-11-01T10:00:00Z');
const call = (id: string, name: string, command: string | undefined, from: number, to: number | null, extra: Partial<TurnToolCall> = {}): TurnToolCall => ({
  id, name, ...(command ? { command } : {}), startedAt: T0 + from * 1000, endedAt: to === null ? null : T0 + to * 1000, ...extra,
});

describe('computeTurnTiming', () => {
  it('splits a turn into categories, model time and the slowest calls', () => {
    const report = computeTurnTiming({
      startedAt: T0,
      endedAt: T0 + 600_000,
      calls: [
        call('1', 'Read', undefined, 5, 6),
        call('2', 'Bash', 'sleep 120 && tail -20 /tmp/t.log', 10, 130),
        call('3', 'Bash', 'pytest posthog -x', 140, 340, { isError: true }),
        call('4', 'Bash', 'cargo install sqlx-cli', 350, 470),
        call('5', 'Bash', 'git status', 480, 482),
      ],
    });
    expect(report.wallMs).toBe(600_000);
    expect(report.calls).toBe(5);
    expect(report.categories).toEqual({
      reading: { ms: 1000, count: 1 },
      waiting: { ms: 120_000, count: 1 },
      tests: { ms: 200_000, count: 1 },
      installs: { ms: 120_000, count: 1 },
      git: { ms: 2000, count: 1 },
      model: { ms: 157_000, count: 0 },
    });
    expect(report.toolMs).toBe(443_000);
    expect(report.modelMs).toBe(157_000);
    expect(report.slowest.map((s) => s.command)).toEqual([
      'pytest posthog -x', 'sleep 120 && tail -20 /tmp/t.log', 'cargo install sqlx-cli', 'git status', undefined,
    ]);
    expect(report.slowest[0]).toMatchObject({ category: 'tests', isError: true, ms: 200_000 });
  });

  it('counts parallel calls once in model time but fully in their categories', () => {
    const report = computeTurnTiming({
      startedAt: T0,
      endedAt: T0 + 100_000,
      calls: [call('a', 'Bash', 'pytest a', 0, 60), call('b', 'Bash', 'pytest b', 20, 80)],
    });
    expect(report.categories.tests).toEqual({ ms: 120_000, count: 2 });
    expect(report.toolMs).toBe(80_000);
    expect(report.modelMs).toBe(20_000);
  });

  it('runs an unfinished call to the end of the turn and clamps calls to the turn', () => {
    const report = computeTurnTiming({
      startedAt: T0,
      endedAt: T0 + 50_000,
      calls: [call('a', 'Bash', 'sleep 999', 40, null), call('b', 'Bash', 'ls', -10, 5)],
    });
    expect(report.categories.waiting).toEqual({ ms: 10_000, count: 1 });
    expect(report.categories.reading).toEqual({ ms: 5_000, count: 1 });
  });

  it('never reports negative model time', () => {
    const report = computeTurnTiming({ startedAt: T0, endedAt: T0 - 5_000, calls: [call('a', 'Bash', 'ls', 0, 0)] });
    expect(report).toMatchObject({ wallMs: 0, toolMs: 0, modelMs: 0 });
  });

  it('keeps only five slow calls, shortened and with secrets removed', () => {
    const calls = Array.from({ length: 8 }, (_, i) => call(String(i), 'Bash', `GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 run ${i} ${'x'.repeat(300)}`, i, i + 1 + i));
    const report = computeTurnTiming({ startedAt: T0, endedAt: T0 + 100_000, calls });
    expect(report.slowest).toHaveLength(5);
    for (const slow of report.slowest) {
      expect(slow.command).not.toContain('ghp_');
      expect(slow.command!.length).toBeLessThanOrEqual(160);
    }
  });
});

describe('sumTurnTimings', () => {
  it('adds turns and lists the newest first', () => {
    const a = computeTurnTiming({ startedAt: T0, endedAt: T0 + 10_000, calls: [call('1', 'Bash', 'pytest', 0, 4)] });
    const b = computeTurnTiming({ startedAt: T0, endedAt: T0 + 20_000, calls: [call('2', 'Bash', 'pytest', 0, 8), call('3', 'Bash', 'sleep 5', 8, 13)] });
    const total = sumTurnTimings('wb', [
      { ...a, chatId: 'c', turn: 1, at: '2026-11-01T10:00:00.000Z' },
      { ...b, chatId: 'c', turn: 2, at: '2026-11-01T11:00:00.000Z' },
    ]);
    expect(total).toMatchObject({ workbenchId: 'wb', turns: 2, wallMs: 30_000, toolMs: 17_000, modelMs: 13_000, calls: 3 });
    expect(total.categories).toEqual({ tests: { ms: 12_000, count: 2 }, waiting: { ms: 5_000, count: 1 }, model: { ms: 13_000, count: 0 } });
    expect(total.recentTurns.map((t) => t.turn)).toEqual([2, 1]);
    expect(total.slowest[0]).toMatchObject({ category: 'tests', ms: 8_000 });
  });

  it('is empty for no turns', () => {
    expect(sumTurnTimings('wb', [])).toMatchObject({ turns: 0, wallMs: 0, categories: {}, slowest: [], recentTurns: [] });
  });
});

describe('formatDurationMs', () => {
  it.each<[number, string]>([[0, '0s'], [12_400, '12s'], [200_000, '3m 20s'], [3_840_000, '1h 4m']])('%d -> %s', (ms, text) => {
    expect(formatDurationMs(ms)).toBe(text);
  });
});
