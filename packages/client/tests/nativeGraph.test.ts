import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { Lifecycle, Socket } from './helpers';

const require = createRequire(import.meta.url);

describe('native package boundary', () => {
  it.each(['import', 'require'])(
    'bundles the %s export without platform dependencies',
    async (condition) => {
      const result = await build({
        stdin: {
          contents:
            condition === 'import'
              ? "import * as client from '@talyn/client/native'; globalThis.client = client;"
              : "globalThis.client = require('@talyn/client/native');",
          resolveDir: process.cwd(),
        },
        bundle: true,
        write: false,
        metafile: true,
        platform: 'neutral',
        format: 'iife',
        conditions: [condition],
      });
      const files = Object.keys(result.metafile!.inputs).filter((file) => file !== '<stdin>');
      expect(files).toHaveLength(6);
      const format = condition === 'import' ? 'esm' : 'cjs';
      expect(files.every((file) => file.includes(`dist/${format}/`))).toBe(true);
      for (const file of files) expect(file).toMatch(/\/(native|config|runtime|http|socket|mobileNotifications)\.js$/);
      const sandbox: Record<string, unknown> = {};
      for (const name of [
        'window',
        'document',
        'navigator',
        'Blob',
        'Storage',
        'indexedDB',
        'process',
        'Buffer',
        'fetch',
        'WebSocket',
        'TextDecoder',
      ]) {
        Object.defineProperty(sandbox, name, {
          get() {
            throw new Error(`Unexpected global access: ${name}`);
          },
        });
      }
      runInNewContext(result.outputFiles[0].text, sandbox);
      const client = sandbox.client as Record<string, unknown>;
      expect(client.configureApiClient).toBeTypeOf('function');
      expect(client.mobileNotifications).toHaveProperty('resolveNotification');
      expect(client.workbenches).not.toHaveProperty('uploadAttachment');
      expect(client.workbenches).not.toHaveProperty('import');
      expect(client.workbenches).not.toHaveProperty('attachmentBlob');
      expect(client).not.toHaveProperty('ReviewRankingArchive');
      expect(client).not.toHaveProperty('ReviewRankingUploader');
    }
  );

  it('keeps the existing CommonJS entry and browser helpers available', () => {
    const client = require('@talyn/client');
    expect(client.workbenches.uploadAttachment).toBeTypeOf('function');
    expect(client.workbenches.import).toBeTypeOf('function');
    expect(client.admin.fleet.followRun).toBeTypeOf('function');
    expect(client.api.workbenches).toBe(client.workbenches);
    expect(client.api.admin).toBe(client.admin);
  });

  it('runs socket authentication and lifecycle recovery through the desktop CommonJS entry', async () => {
    const client: typeof import('../src/index') = require('@talyn/client');
    const lifecycle = new Lifecycle();
    const sockets: Socket[] = [];
    client.configureApiClient({
      baseUrl: 'https://example.test',
      clientVersion: 'desktop/test',
      getAccessToken: async () => 'token',
      recoverSession: async () => false,
      runtime: {
        lifecycle,
        createWebSocket: (url) => {
          const socket = new Socket(url);
          sockets.push(socket);
          return socket;
        },
      },
    });
    const socket = new client.WebSocketClient();
    try {
      socket.subscribe('workspace');
      await socket.connect();
      sockets[0].open();
      expect(sockets[0].sent).toEqual([{ type: 'auth', token: 'token' }]);
      sockets[0].accept();
      lifecycle.update({ activity: 'suspended' });
      expect(sockets[0].close).toHaveBeenCalledOnce();
      lifecycle.update({ activity: 'active' });
      await socket.connect();
      // Let the token lookup from the lifecycle callback finish.
      await Promise.resolve();
      sockets[1].open();
      sockets[1].accept();
      expect(sockets[1].sent).toEqual([
        { type: 'auth', token: 'token' },
        { type: 'subscribe', workspaceId: 'workspace' },
      ]);
    } finally {
      socket.dispose();
    }
    expect(lifecycle.listeners.size).toBe(0);
  });
});
