import { describe, expect, it } from 'vitest';
import { mcpServerFromAddress, mcpServerInputProblem, mcpServerNameProblem } from '@talyn/shared';

describe('automatic MCP connection details', () => {
  it.each([
    ['https://mcp.example.com/mcp', 'example-com'],
    ['https://api.githubcopilot.com/mcp/', 'github-mcp'],
    ['https://github/', 'github-mcp'],
    ['https://tools.example.com/mcp', 'tools-example-com'],
    [`https://${'a'.repeat(60)}.example.com/mcp`, 'a'.repeat(40)],
  ])('fills a valid name for %s', (url, name) => {
    const input = mcpServerFromAddress(url);
    expect(input.name).toBe(name);
    expect(mcpServerInputProblem(input)).toBeNull();
  });
  it('uses catalog details for known addresses', () => {
    expect(mcpServerFromAddress('https://mcp.context7.com/mcp')).toMatchObject({
      name: 'context7',
      catalogHandle: 'context7',
      displayName: 'Context7',
      authKind: 'header',
      inject: { header: 'CONTEXT7_API_KEY' },
    });
  });
  it('avoids existing names', () => {
    expect(
      mcpServerFromAddress('https://mcp.example.com/mcp', ['example-com', 'example-com-2']).name
    ).toBe('example-com-3');
  });
  it('keeps long duplicate names within the limit', () => {
    const input = mcpServerFromAddress(`https://${'a'.repeat(60)}.com/mcp`, ['a'.repeat(40)]);
    expect(input.name).toHaveLength(40);
    expect(mcpServerInputProblem(input)).toBeNull();
  });
});

describe('MCP server identifier checks', () => {
  it.each([
    ['linear', [], null],
    ['Linear', [], null],
    ['  linear-work  ', [], null],
    ['linear', ['linear'], /already uses "linear"/],
    ['Linear', ['linear'], /already uses "linear"/],
    ['', [], /needs a name/],
    ['linear work', [], /cannot be an MCP server name/],
    ['-linear', [], /cannot be an MCP server name/],
    ['linear-', [], /cannot end with a hyphen/],
    ['github', [], /is reserved/],
    ['a'.repeat(41), [], /cannot be an MCP server name/],
  ] as const)('checks %j against %j', (name, existing, expected) => {
    const problem = mcpServerNameProblem(name, existing);
    if (expected === null) expect(problem).toBeNull();
    else expect(problem).toMatch(expected);
  });
});
