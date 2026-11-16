import { describe, expect, it } from 'vitest';
import type { FleetAccount } from '../services/selfHosted/accounts.js';
import { credentialFailure } from '../services/workbenches/credentialFailure.js';

const now = new Date('2026-11-16T12:00:00Z');
const reset = '2026-11-16T15:00:00.000Z';
const later = '2026-11-17T12:00:00.000Z';
const account = (id: string, patch: Partial<FleetAccount> = {}): FleetAccount => ({
  id, label: id, workspaceId: 'ws', agent: 'claude', kind: 'claude_oauth', priority: 1,
  reauthRequiredAt: null, quotaExhausted: null, usage: null, createdAt: now.toISOString(), updatedAt: now.toISOString(), ...patch,
});
const usage = (resetsAt: string | null, usedPercent = 100) => ({
  fetchedAt: now.toISOString(), windows: [{ key: 'five_hour', label: '5-hour', usedPercent, resetsAt }],
});
const stale = account('Personal', { reauthRequiredAt: now.toISOString() });
const full = account('Work', { usage: usage(reset) });

describe('credential refusal', () => {
  it.each([
    { accounts: [], reason: 'missing', text: 'This workspace has no Claude account. Connect it in Settings → Talyn Fleet.', ids: [] },
    { accounts: [stale], reason: 'reauth', text: 'Personal needs to be signed in again. Reconnect it in Settings → Talyn Fleet.', ids: ['Personal'] },
    { accounts: [stale, { ...stale, id: 'Second', label: 'Second' }], reason: 'reauth', text: 'Personal and Second need to be signed in again. Reconnect them in Settings → Talyn Fleet.', ids: ['Personal', 'Second'] },
    { accounts: [full], reason: 'limited', text: `Work is at its usage limit. The first known reset is at Mon 15:00 UTC.`, ids: ['Work'] },
    { accounts: [account('Work', { usage: usage(null) })], reason: 'limited', text: 'Work is at its usage limit.', ids: ['Work'] },
    { accounts: [stale, full], reason: 'reauth', text: `Personal needs to be signed in again. Reconnect it in Settings → Talyn Fleet. Work is at its usage limit. The first known reset is at Mon 15:00 UTC.`, ids: ['Personal'] },
    { accounts: [account('Work')], reason: 'unavailable', text: "This workspace's Claude accounts are not available. Try again shortly.", ids: ['Work'] },
  ])('$reason: $text', ({ accounts, reason, text, ids }) => {
    expect(credentialFailure(accounts, 'claude', { threshold: 95, now })).toMatchObject({
      message: text, status: 409, code: 'credentials_unavailable', details: { reason, accountIds: ids },
    });
  });

  it.each(['claude', 'codex'] as const)('suggests the other usable agent for %s', (agent) => {
    const other = agent === 'claude' ? 'codex' : 'claude';
    const error = credentialFailure([{ ...full, agent }, account('Backup', { agent: other })], agent, { threshold: 95, now });
    expect(error.message).toContain(`or switch this chat to ${other === 'claude' ? 'Claude' : 'Codex'}.`);
  });

  it.each([
    { reauthRequiredAt: now.toISOString() },
    { usage: usage(reset) },
    { quotaExhausted: { at: now.toISOString(), detail: 'limited', kind: 'rate_limit' as const, resetsAt: reset } },
  ])('does not suggest an unavailable backup: %j', (patch) => {
    expect(credentialFailure([full, account('Backup', { agent: 'codex', ...patch })], 'claude', { threshold: 95, now }).message).not.toContain('switch');
  });

  it('uses the first account reset after all its blocking windows reset', () => {
    const multi = account('Work', { usage: { ...usage(reset), windows: [...usage(reset).windows, { ...usage(later).windows[0], key: 'weekly' }] } });
    expect(credentialFailure([multi], 'claude', { threshold: 95, now }).message).toContain('Tue 12:00 UTC');
    expect(credentialFailure([multi, account('Second', { usage: usage(reset) })], 'claude', { threshold: 95, now }).message).toContain('Mon 15:00 UTC');
  });

  it.each([null, 'invalid', '2026-11-15T12:00:00Z'])('does not invent a reset for %s', (resetsAt) => {
    expect(credentialFailure([account('Work', { usage: usage(resetsAt) })], 'claude', { threshold: 95, now }).message).not.toContain('reset');
  });

  it('reports a stored quota hold and its known reset', () => {
    const held = account('Held', { quotaExhausted: { at: now.toISOString(), detail: 'limited', kind: 'rate_limit', resetsAt: reset } });
    expect(credentialFailure([held], 'claude', { threshold: 95, now }).message).toBe(`Held is at its usage limit. The first known reset is at Mon 15:00 UTC.`);
  });

  it('uses a known usage reset when the hold has no reset', () => {
    const held = account('Held', { usage: usage(reset), quotaExhausted: { at: now.toISOString(), detail: 'limited' } });
    expect(credentialFailure([held], 'claude', { threshold: 95, now }).message).toContain('Mon 15:00 UTC');
  });

  it('keeps the teammate wording', () => {
    expect(credentialFailure([stale, full], 'claude', { threshold: 95, now, payer: true }).message)
      .toMatch(/^These accounts are in your workspace\..*Use your workspace accounts to prompt this session\.$/);
    expect(credentialFailure([], 'codex', { threshold: 95, now, payer: true }).message).toContain('Your workspace has no Codex account.');
  });

  it('uses the model scope and the effective selection threshold', () => {
    const scoped = account('Work', { usage: { ...usage(reset), windows: [{ ...usage(reset, 97).windows[0], scopeModel: 'Opus' }] } });
    expect(credentialFailure([scoped], 'claude', { threshold: 95, now, model: 'claude-opus' }).details?.reason).toBe('limited');
    expect(credentialFailure([scoped], 'claude', { threshold: 100, now, model: 'claude-opus' }).details?.reason).toBe('unavailable');
    expect(credentialFailure([scoped], 'claude', { threshold: 95, now, model: 'claude-sonnet' }).details?.reason).toBe('unavailable');
  });
});
