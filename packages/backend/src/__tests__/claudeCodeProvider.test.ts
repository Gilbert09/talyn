import { describe, it, expect } from 'vitest';
import { claudeCodeProvider } from '../services/cloudProviders/claude/provider.js';
import {
  registerCloudProvider,
  getCloudProvider,
  listCloudProviders,
} from '../services/cloudProviders/registry.js';

describe('claudeCodeProvider — CloudTaskProvider conformance', () => {
  it('declares the expected identity + capabilities', () => {
    expect(claudeCodeProvider.type).toBe('claude_routine');
    expect(claudeCodeProvider.displayName).toBe('Claude Code');
    expect(claudeCodeProvider.capabilities).toMatchObject({ model: true });
  });

  it('implements the full provider surface', () => {
    for (const method of [
      'validateCredentials',
      'hasCredentials',
      'testConnection',
      'removeCredentials',
      'dispatch',
      'reconcile',
      'stopStreaming',
      'cancel',
    ] as const) {
      expect(typeof claudeCodeProvider[method]).toBe('function');
    }
  });

  it('rejects credentials missing the required fields (no DB/network hit)', async () => {
    expect(await claudeCodeProvider.validateCredentials('ws1', {})).toEqual({
      ok: false,
      error: 'anthropicApiKey and githubToken are required',
    });
    expect(
      await claudeCodeProvider.validateCredentials('ws1', { anthropicApiKey: 'sk-ant-x' }),
    ).toMatchObject({ ok: false });
  });

  it('registers and resolves through the registry by type', () => {
    registerCloudProvider(claudeCodeProvider);
    expect(getCloudProvider('claude_routine')).toBe(claudeCodeProvider);
    expect(listCloudProviders().some((p) => p.type === 'claude_routine')).toBe(true);
  });
});
