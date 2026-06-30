import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.js';

/**
 * The Debug surface is a cross-tenant operator view (it streams backend
 * internals across every account), so it must stay gated to the single
 * `is_admin` account — set via TALYN_ADMIN_EMAILS, never self-promotable
 * through a route. This locks that gate.
 */
function makeRes() {
  const statusCalls: number[] = [];
  const bodies: unknown[] = [];
  const res = {
    status(code: number) {
      statusCalls.push(code);
      return res;
    },
    json(b: unknown) {
      bodies.push(b);
      return res;
    },
    statusCalls,
    bodies,
  };
  return res;
}

describe('requireAdmin (Debug-panel gate)', () => {
  it('403s a non-admin user', () => {
    const res = makeRes();
    let nexted = false;
    requireAdmin(
      { user: { id: 'u1', email: 'a@b.test', isAdmin: false } } as unknown as Request,
      res as unknown as Response,
      () => {
        nexted = true;
      }
    );
    expect(nexted).toBe(false);
    expect(res.statusCalls).toEqual([403]);
    expect(res.bodies[0]).toEqual({ success: false, error: 'Admin access required' });
  });

  it('403s when there is no user at all', () => {
    const res = makeRes();
    let nexted = false;
    requireAdmin({} as unknown as Request, res as unknown as Response, () => {
      nexted = true;
    });
    expect(nexted).toBe(false);
    expect(res.statusCalls).toEqual([403]);
  });

  it('passes an admin user through', () => {
    const res = makeRes();
    let nexted = false;
    requireAdmin(
      { user: { id: 'u1', email: 'a@b.test', isAdmin: true } } as unknown as Request,
      res as unknown as Response,
      () => {
        nexted = true;
      }
    );
    expect(nexted).toBe(true);
    expect(res.statusCalls).toEqual([]);
  });
});
