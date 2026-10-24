import { describe, expect, it } from 'vitest';
import { detectPreview, PREVIEW_DETECT_PATHS } from '@talyn/shared';

type Input = Parameters<typeof detectPreview>[0];

const detect = (files: Input['files'], paths: string[] = []) => detectPreview({ files, paths });

describe('detectPreview', () => {
  it('finds a PostHog Coder workspace and excludes infrastructure ports', () => {
    const result = detect({
      'hogli.yaml': '  devbox:\n    coder_url: https://coder.dev.posthog.dev',
      'docker-compose.dev.yml': 'services:\n  web:\n    ports:\n      - "127.0.0.1:8010:8000"\n  db:\n    ports:\n      - "5432:5432"\n  clickhouse:\n    ports:\n      - "8123:8123"',
      'package.json': JSON.stringify({ scripts: { start: './bin/start' } }),
    });
    expect(result.target).toBe('coder');
    expect(result.coder?.url).toBe('https://coder.dev.posthog.dev');
    expect(result.ports).toEqual([{ port: 8010, primary: true }]);
  });

  it.each([
    ['Vite', 'vite', 5173],
    ['Next', 'next dev', 3000],
    ['React Scripts', 'react-scripts start', 3000],
    ['Astro', 'astro dev', 4321],
    ['Nuxt', 'nuxt dev', 3000],
    ['Remix', 'remix dev', 3000],
    ['SvelteKit', 'svelte-kit dev', 5173],
    ['explicit port', 'vite --port 4000', 4000],
    ['short port', 'next dev -p 4001', 4001],
    ['environment port', 'PORT=4002 vite', 4002],
  ])('detects %s from package.json', (_name, command, port) => {
    const result = detect({ 'package.json': JSON.stringify({ scripts: { dev: command } }) });
    expect(result.target).toBe('sandbox');
    expect(result.ports).toEqual([{ port, primary: true }]);
  });

  it.each([
    ['number', '{ // a comment\n "forwardPorts": [5173] /* another comment */ }', 5173],
    ['host:port', '{"forwardPorts": ["localhost:4000"]}', 4000],
    ['URL in string', '{"name":"https://example.com", "forwardPorts":[4321]}', 4321],
  ])('reads devcontainer %s ports', (_name, source, port) => {
    const result = detect({ '.devcontainer/devcontainer.json': source });
    expect(result.ports).toEqual([{ port, primary: true }]);
  });

  it.each([
    ['long option', 'web: node server --port 4000', 4000],
    ['short option', 'web: node server -p 4001', 4001],
    ['environment', 'web: PORT=4002 node server', 4002],
    ['colon', 'web: node server :4003', 4003],
  ])('reads Procfile %s', (_name, source, port) => {
    expect(detect({ Procfile: source }).ports).toEqual([{ port, primary: true }]);
  });

  it.each(['mprocs.yaml', 'bin/mprocs.yaml'])('reads %s ports', (path) => {
    expect(detect({ [path]: 'web: npm run dev -- --port 4000' }).ports).toEqual([{ port: 4000, primary: true }]);
  });

  it.each([
    ['.coder directory', {}, ['.coder']],
    ['Terraform provider', { 'main.tf': 'provider "coder" {}' }, []],
    ['Terraform app in another file', { 'infra/workspace.tf': 'resource "coder_app" "web" {}' }, []],
    ['Terraform agent', { 'main.tf': 'resource "coder_agent" "dev" {}' }, []],
  ] satisfies Array<[string, Input['files'], string[]]>)('detects %s', (_name, files, paths) => {
    const result = detect(files, paths);
    expect(result.target).toBe('coder');
    expect(result.coder?.reason).toBeTruthy();
  });

  it('treats Coder documentation as a weak hint', () => {
    const result = detect({}, ['docs/internal/coder-workspaces.md']);
    expect(result.target).toBeNull();
    expect(result.coderHint).toContain('coder-workspaces.md');
    expect(result.coder).toBeUndefined();
  });

  it.each([
    ['off', 'off'],
    ['sandbox', 'sandbox'],
    ['coder', 'coder'],
  ] as const)('lets the explicit %s target win', (_name, target) => {
    const result = detect({
      '.talyn/settings.toml': `[preview]\ntarget = "${target}"\nports = [8010]\n[preview.coder]\nurl = "https://coder.example.com"`,
    });
    expect(result.target).toBe(target);
    expect(result.coder?.url).toBe('https://coder.example.com');
    expect(result.ports).toEqual([{ port: 8010, primary: true }]);
  });

  it('uses the config parser for quoted keys and inline Coder values', () => {
    const result = detect({ '.talyn/settings.toml': '[preview.coder]\n"url" = "https://coder.example.com"\n"template" = "dev"' });
    expect(result.coder).toMatchObject({ url: 'https://coder.example.com', template: 'dev' });
  });

  it('prefers configured Coder settings over hogli.yaml', () => {
    const result = detect({
      '.talyn/settings.toml': '[preview.coder]\nurl = "https://configured.example.com"\ncheckout = "~/app"',
      'hogli.yaml': 'coder_url: https://hogli.example.com',
    });
    expect(result.coder).toEqual({ url: 'https://configured.example.com', reason: 'Found [preview.coder] in .talyn/settings.toml.' });
  });

  it('keeps configured, devcontainer, package, compose, then Procfile ports', () => {
    const result = detect({
      '.talyn/settings.toml': '[preview]\nports = [8010, 8010]',
      'devcontainer.json': '{"forwardPorts":[3001,8010]}',
      'package.json': '{"scripts":{"dev":"vite"}}',
      'compose.yml': 'services:\n  app:\n    ports:\n      - 4000:80\n      - 5173:5173\n      - 6379:6379',
      Procfile: 'web: node app --port 5000',
    });
    expect(result.ports.map(({ port }) => port)).toEqual([8010, 3001, 5173, 4000, 5000]);
    expect(result.ports[0].primary).toBe(true);
    expect(result.ports.slice(1).every(({ primary }) => !primary)).toBe(true);
  });

  it('caps the port list at eight', () => {
    const result = detect({ '.talyn/settings.toml': '[preview]\nports = [1024, 1025, 1026, 1027, 1028, 1029, 1030, 1031, 1032]' });
    expect(result.ports).toHaveLength(8);
  });

  it('returns no target or ports when no signal exists', () => {
    expect(detect({})).toEqual({ target: null, ports: [], reasons: [] });
  });

  it('lists each file the caller should read', () => {
    expect(PREVIEW_DETECT_PATHS).toContain('.talyn/settings.toml');
    expect(PREVIEW_DETECT_PATHS).toContain('main.tf');
    expect(PREVIEW_DETECT_PATHS).toContain('bin/mprocs.yaml');
  });
});
