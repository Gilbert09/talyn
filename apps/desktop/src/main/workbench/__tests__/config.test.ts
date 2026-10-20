/** @jest-environment node */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { readConfig, readConfigWithDetection, saveDetectedConfig } from '../config';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'talyn-config-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

it('keeps detection separate from executable config and detects only root files', async () => {
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, 'nested', 'uv.lock'), '');
  await fs.writeFile(path.join(root, 'package.json'), '{"scripts":{"dev":"vite"}}');
  expect(await readConfig(root)).toMatchObject({ source: 'none', run: [] });
  expect((await readConfig(root)).setup).toBeUndefined();
  expect((await readConfigWithDetection(root)).detected).toEqual({
    setup: { command: 'npm install', reason: 'from package.json' },
    run: { command: 'npm run dev', reason: 'from the dev script in package.json' },
  });
});

it('detects again when saving and reads the saved config', async () => {
  await fs.writeFile(path.join(root, 'package.json'), '{"scripts":{"dev":"vite"}}');
  await readConfigWithDetection(root);
  await fs.writeFile(path.join(root, 'pnpm-lock.yaml'), '');
  await saveDetectedConfig(root);
  const config = await readConfigWithDetection(root);
  expect(config.source).toBe('talyn');
  expect(config.setup?.command).toBe('pnpm install --frozen-lockfile');
  expect(config.run[0]?.command).toBe('pnpm dev');
  expect(config.detected).toBeUndefined();
});

it.each(['.talyn/settings.toml', 'conductor.json', '.conductor/settings.toml'])(
  'refuses to overwrite an empty config at %s',
  async (relative) => {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '');
    await fs.writeFile(path.join(root, 'package.json'), '{}');
    await expect(saveDetectedConfig(root)).rejects.toThrow('already exists');
    expect(await fs.readFile(target, 'utf8')).toBe('');
    if (relative !== '.talyn/settings.toml') {
      await expect(fs.stat(path.join(root, '.talyn/settings.toml'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  },
);

it('refuses to save when nothing is detected', async () => {
  await expect(saveDetectedConfig(root)).rejects.toThrow('No setup or run command was detected.');
  await expect(fs.stat(path.join(root, '.talyn'))).rejects.toMatchObject({ code: 'ENOENT' });
});
