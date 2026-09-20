import { describe, expect, it } from 'vitest';
import { mcpToolCountLabel } from '@talyn/shared';

describe('MCP tool counts', () => {
  it.each([
    [null, ['a', 'b', 'c'], '3/3 tools'],
    [undefined, ['a', 'b'], '2/2 tools'],
    [[], ['a', 'b'], '0/2 tools'],
    [['a'], ['a', 'b'], '1/2 tools'],
    [['a', 'removed'], ['a', 'b'], '1/2 tools'],
    [['a', 'a'], ['a', 'a', 'b'], '1/2 tools'],
    [null, [], '0/0 tools'],
  ])('counts selection %j against available tools %j', (tools, toolNames, expected) => {
    expect(mcpToolCountLabel({ tools, lastProbe: { ok: true, at: '', toolNames } })).toBe(expected);
  });
  it.each([undefined, null, { ok: false, at: '', toolNames: ['a'] }, { ok: true, at: '' }])(
    'does not invent counts for missing or failed discovery: %j',
    (lastProbe) => expect(mcpToolCountLabel({ tools: null, lastProbe })).toBe('Tools not loaded')
  );
});
