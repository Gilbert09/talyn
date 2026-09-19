import { describe, expect, it } from 'vitest';
import { mcpServerFromAddress, mcpServerInputProblem } from '@talyn/shared';

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
