import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  cacheDir: '.work/vite',
  resolve: {
    alias: { '@talyn/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) },
  },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
