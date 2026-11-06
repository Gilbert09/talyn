import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexProviderPrelude } from '../services/workbenches/codexProvider.js';

const begin = '# BEGIN fleet codex provider — written by fleet-init; edits between the markers are lost';
const end = '# END fleet codex provider';
const block = (url: string) => [
  begin,
  'model_provider = "yas"',
  'model_providers.yas.name = "OpenAI through the yas credential proxy"',
  `model_providers.yas.base_url = "${url}/v1"`,
  'model_providers.yas.env_key = "OPENAI_API_KEY"',
  'model_providers.yas.wire_api = "responses"',
  end,
  '',
].join('\n');

describe('Codex guest provider setup', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function guest(initial?: string) {
    const home = mkdtempSync(join(tmpdir(), 'talyn-codex-provider-'));
    dirs.push(home);
    const config = join(home, '.codex', 'config.toml');
    if (initial !== undefined) {
      mkdirSync(join(home, '.codex'));
      writeFileSync(config, initial);
    }
    const read = () => { try { return readFileSync(config, 'utf8'); } catch { return null; } };
    const run = (proxy = 'http://fleet-proxy:8080/', key?: string) => {
      const result = spawnSync('/bin/sh', ['-c', `${codexProviderPrelude()}\nprintf '%s' "$OPENAI_API_KEY"`], {
        encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home, FLEET_PROXY_URL: proxy, ...(key === undefined ? {} : { OPENAI_API_KEY: key }) },
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      return result.stdout;
    };
    return { config, read, run };
  }

  it('writes the block when no config exists', () => {
    const box = guest();
    expect(box.run()).toBe('not-a-key-the-fleet-proxy-injects-host-side');
    expect(box.read()).toBe(block('http://fleet-proxy:8080'));
  });

  it('prepends the block and keeps user settings', () => {
    const user = '[projects."/work/app"]\ntrust_level = "trusted"\n';
    const box = guest(user);
    box.run();
    expect(box.read()).toBe(block('http://fleet-proxy:8080') + user);
  });

  it('replaces an old block and keeps the rest', () => {
    const user = '[notice]\nhide_full_access_warning = true\n';
    const box = guest(user + block('http://old-proxy'));
    expect(box.run('http://new-proxy/', 'existing-key')).toBe('existing-key');
    expect(box.read()).toBe(block('http://new-proxy') + user);
  });

  it('leaves a correct config byte-identical', () => {
    const content = block('http://fleet-proxy:8080') + '[model]\nname = "custom"\n';
    const box = guest(content);
    const before = statSync(box.config);
    box.run();
    expect(box.read()).toBe(content);
    expect(statSync(box.config).ino).toBe(before.ino);
  });

  it('does not write config without a proxy URL', () => {
    const box = guest();
    box.run('');
    expect(box.read()).toBeNull();
  });
});
