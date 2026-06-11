import { describe, expect, it } from 'vitest';
import { TokenHealthTracker } from '../services/tokenHealthPoller.js';
import type { TokenHealthCheck } from '../services/github.js';

const NOW = new Date('2026-06-11T12:00:00Z');

function check(overrides: Partial<TokenHealthCheck> = {}): TokenHealthCheck {
  return {
    workspaceId: 'ws-1',
    fingerprint: 'aabbccdd',
    storedCreatedAt: '2026-06-11T10:00:00Z',
    valid: true,
    login: 'Gilbert09',
    githubCreatedAt: '2026-06-11T10:00:01Z',
    expiresAt: null,
    scopes: ['repo', 'workflow'],
    ...overrides,
  };
}

describe('TokenHealthTracker', () => {
  it('logs identity on first healthy sighting', () => {
    const tracker = new TokenHealthTracker();
    const act = tracker.observe(check(), NOW);
    expect(act).not.toBeNull();
    expect(act!.action).toBe('token:health-first-check');
    expect(act!.level).toBe('log');
    expect(act!.summary).toContain('fp:aabbccdd');
    expect(act!.summary).toContain('login=Gilbert09');
    expect(act!.summary).toContain('expires_at=never');
    expect(act!.summary).toContain('(stored 2h ago)');
  });

  it('surfaces a scheduled expiry in the first-check line', () => {
    const tracker = new TokenHealthTracker();
    const act = tracker.observe(check({ expiresAt: '2026-06-11T18:00:00Z' }), NOW);
    expect(act!.summary).toContain('expires_at=2026-06-11T18:00:00Z');
    expect(act!.meta.expiresAt).toBe('2026-06-11T18:00:00Z');
  });

  it.each([
    ['second healthy check', 2],
    ['tenth healthy check', 10],
  ])('stays quiet on steady healthy state (%s)', (_label, n) => {
    const tracker = new TokenHealthTracker();
    tracker.observe(check(), NOW);
    let act = null;
    for (let i = 1; i < n; i++) act = tracker.observe(check(), NOW);
    expect(act).toBeNull();
  });

  it('logs loudly on valid → invalid transition', () => {
    const tracker = new TokenHealthTracker();
    tracker.observe(check(), NOW);
    const act = tracker.observe(check({ valid: false }), NOW);
    expect(act).not.toBeNull();
    expect(act!.action).toBe('token:health-died');
    expect(act!.level).toBe('error');
    expect(act!.summary).toContain('REVOKED');
    expect(act!.meta.deadAtFirstCheck).toBe(false);
  });

  it('flags a token that is already dead at first sighting', () => {
    const tracker = new TokenHealthTracker();
    const act = tracker.observe(check({ valid: false }), NOW);
    expect(act).not.toBeNull();
    expect(act!.action).toBe('token:health-died');
    expect(act!.summary).toContain('already dead at first check');
    expect(act!.meta.deadAtFirstCheck).toBe(true);
  });

  it('stays quiet on repeated invalid checks after the death was reported', () => {
    const tracker = new TokenHealthTracker();
    tracker.observe(check(), NOW);
    tracker.observe(check({ valid: false }), NOW);
    expect(tracker.observe(check({ valid: false }), NOW)).toBeNull();
  });

  it('reports a replacement token (new fingerprint) as a fresh first check', () => {
    const tracker = new TokenHealthTracker();
    tracker.observe(check(), NOW);
    tracker.observe(check({ valid: false }), NOW);
    const act = tracker.observe(check({ fingerprint: 'eeff0011' }), NOW);
    expect(act!.action).toBe('token:health-first-check');
    expect(act!.summary).toContain('fp:eeff0011');
  });

  it('tracks workspaces independently', () => {
    const tracker = new TokenHealthTracker();
    tracker.observe(check(), NOW);
    const act = tracker.observe(check({ workspaceId: 'ws-2' }), NOW);
    expect(act!.action).toBe('token:health-first-check');
    const died = tracker.observe(check({ workspaceId: 'ws-2', valid: false }), NOW);
    expect(died!.action).toBe('token:health-died');
    // ws-1 remains healthy and quiet.
    expect(tracker.observe(check(), NOW)).toBeNull();
  });

  it('handles an unparsable storedCreatedAt without throwing', () => {
    const tracker = new TokenHealthTracker();
    const act = tracker.observe(check({ storedCreatedAt: 'not-a-date' }), NOW);
    expect(act!.summary).toContain('(stored ? ago)');
  });
});
