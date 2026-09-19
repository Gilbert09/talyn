import { describe, it, expect } from 'vitest';
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
