import { describe, it, expect } from 'vitest';
import * as shared from '@talyn/shared';
import { FEATURE_FLAGS, readFlagOverride } from '@talyn/shared';

/**
 * `mcpServers` is the one flag with no env override, and the register is where
 * that has to stay true: adding one back would hand this flag a second source
 * of truth, which is exactly what Tom asked it not to have.
 */
describe('the mcpServers flag has no env override', () => {
  it('declares none', () => {
    expect(FEATURE_FLAGS.mcpServers.envOverride).toBeUndefined();
  });

  it('cannot be answered from the environment, whatever is set', () => {
    for (const value of ['true', 'false', '1', '0', 'on', 'off']) {
      expect(readFlagOverride('mcpServers', { MCP_SERVERS_ENABLED: value })).toBeUndefined();
    }
  });

  // The guard against the rule being quietly generalised: its siblings still
  // have overrides, and losing those would be a separate, silent regression.
  it('is alone in having none', () => {
    for (const key of ['workflows', 'loops', 'fleet'] as const) {
      expect(FEATURE_FLAGS[key].envOverride, key).toBeTruthy();
    }
  });
});

/**
 * MCP servers are uncapped on every plan.
 *
 * They were capped at 3 like tasks, queued PRs, workflows and loops, and that
 * was the wrong shape: each of those SPENDS something by existing, while a
 * connected MCP server spends nothing until a run uses it — and what the run
 * costs is bounded by the task cap already. Charging for the connection was
 * charging twice for one thing.
 *
 * Asserted on the register rather than on a route, because the way this comes
 * back is somebody reintroducing the constant.
 */
describe('MCP servers have no plan cap', () => {
  it('exports no free-plan limit and no limit error code', () => {
    expect('FREE_PLAN_MCP_SERVER_LIMIT' in shared).toBe(false);
    expect('MCP_SERVER_LIMIT_ERROR_CODE' in shared).toBe(false);
  });

  // The siblings still have theirs — this is one feature's decision, not a
  // change of policy about caps in general.
  it('leaves the other caps alone', () => {
    expect(shared.FREE_PLAN_ACTIVE_TASK_LIMIT).toBeGreaterThan(0);
    expect(shared.FREE_PLAN_WORKFLOW_LIMIT).toBeGreaterThan(0);
    expect(shared.FREE_PLAN_LOOP_LIMIT).toBeGreaterThan(0);
  });
});
