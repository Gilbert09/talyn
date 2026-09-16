import { describe, it, expect } from 'vitest';
import {
  MCP_CATALOG,
  mcpServerFromCatalog,
  mcpServerInputProblem,
  validateMcpServer,
  type McpServerInput,
} from '@talyn/shared';

/**
 * The validator mirrors the fleet's own refusals.
 *
 * Every rule here is enforced again on dispatch, in Go, by a different
 * implementation — so these tests are not about safety. They are about a
 * person hearing "an MCP url needs a path" while they are typing rather than
 * as a task that failed an hour later with a message nobody can act on. A rule
 * that drifts from the fleet's costs exactly that.
 */

function input(over: Partial<McpServerInput> = {}): McpServerInput {
  return {
    name: 'linear',
    url: 'https://mcp.linear.app/mcp',
    authKind: 'bearer',
    enabled: true,
    ...over,
  };
}

describe('validateMcpServer', () => {
  it('accepts an ordinary server', () => {
    const got = validateMcpServer(input({ description: 'Issue tracker' }));
    expect(got.name).toBe('linear');
    expect(got.url).toBe('https://mcp.linear.app/mcp');
    expect(got.description).toBe('Issue tracker');
    // Unrestricted by default: null, not [].
    expect(got.tools).toBeNull();
  });

  it.each([
    ['no name', { name: '' }, /needs a name/],
    ['a name with a space', { name: 'my server' }, /lowercase letters/],
    ['a name ending in a hyphen', { name: 'linear-' }, /hyphen/],
    ['a name over 40 characters', { name: 'a'.repeat(41) }, /lowercase letters/],
    ['no url', { url: '' }, /needs a URL/],
    ['a url that is not one', { url: 'not a url' }, /is not a URL/],
    ['credentials in the url', { url: 'https://u:p@mcp.linear.app/mcp' }, /in the key field/],
    ['a fragment', { url: 'https://mcp.linear.app/mcp#x' }, /#fragment/],
    ['a query string', { url: 'https://mcp.linear.app/mcp?read_only=true' }, /query string/],
  ])('refuses %s', (_label, over, expected) => {
    expect(() => validateMcpServer(input(over as Partial<McpServerInput>))).toThrow(expected);
  });

  // That name is the sandbox's own GitHub REST API. Taking it would silently
  // remove a capability the agent briefing promises, and nothing would say so.
  // Normalised rather than refused: the name is a DNS label, so "Linear" has
  // exactly one sensible reading, and the human spelling survives on displayName.
  // Some servers really do answer at the root — Stripe's is
  // `https://mcp.stripe.com/`, and every /mcp spelling 404s. The fleet accepts
  // an explicit root but refuses a path-less URL, and only Go can tell the two
  // apart, so the normalisation here is what makes a pasted bare host work.
  it('normalises a root endpoint to the form the fleet accepts', () => {
    expect(validateMcpServer(input({ url: 'https://mcp.stripe.com' })).url).toBe(
      'https://mcp.stripe.com/',
    );
    expect(validateMcpServer(input({ url: 'https://mcp.stripe.com/' })).url).toBe(
      'https://mcp.stripe.com/',
    );
  });

  it('leaves a real path alone', () => {
    expect(validateMcpServer(input({ url: 'https://mcp.linear.app/mcp' })).url).toBe(
      'https://mcp.linear.app/mcp',
    );
  });

  it('lower-cases a name rather than refusing it', () => {
    expect(validateMcpServer(input({ name: 'Linear' })).name).toBe('linear');
  });

  it('refuses the name "github", which is the sandbox\'s own GitHub API', () => {
    expect(() => validateMcpServer(input({ name: 'github' }))).toThrow(/reserved/);
  });

  // A sandbox has no routed egress. One of these is not "restricted", it is
  // unreachable — and 169.254.169.254 is why the rule exists at all.
  it.each([
    'http://localhost:4517/mcp',
    'http://127.0.0.1:4517/mcp',
    'http://10.0.0.5/mcp',
    'http://192.168.1.4/mcp',
    'http://172.16.0.9/mcp',
    'http://169.254.169.254/mcp',
    'http://something.local/mcp',
  ])('refuses %s, which a sandbox cannot reach', (url) => {
    expect(() => validateMcpServer(input({ url }))).toThrow(/cannot reach/);
  });

  describe('the tool allow-list', () => {
    it('keeps null and [] apart, because they are opposite answers', () => {
      expect(validateMcpServer(input({ tools: null })).tools).toBeNull();
      expect(validateMcpServer(input({ tools: [] })).tools).toEqual([]);
    });

    it('deduplicates but keeps the order the user wrote', () => {
      const got = validateMcpServer(input({ tools: ['list_issues', 'create_issue', 'list_issues'] }));
      expect(got.tools).toEqual(['list_issues', 'create_issue']);
    });

    it('refuses a name no tool could ever have', () => {
      expect(() => validateMcpServer(input({ tools: ['create issue'] }))).toThrow(/is not a tool name/);
      expect(() => validateMcpServer(input({ tools: [''] }))).toThrow(/is not a tool name/);
    });
  });

  describe('credential shapes', () => {
    it('needs the header name for a header credential', () => {
      expect(() => validateMcpServer(input({ authKind: 'header' }))).toThrow(/header name/);
      expect(
        validateMcpServer(input({ authKind: 'header', inject: { header: 'X-Api-Key' } })).inject,
      ).toEqual({ header: 'X-Api-Key' });
    });

    it('needs the username for a basic credential', () => {
      expect(() => validateMcpServer(input({ authKind: 'basic' }))).toThrow(/username/);
    });

    it('needs the parameter name for a query credential', () => {
      expect(() => validateMcpServer(input({ authKind: 'query' }))).toThrow(/parameter name/);
    });

    // Absent and empty are different gestures: one keeps the stored credential,
    // the other clears it. Collapsing them would make every rename silently
    // disconnect the server.
    it('keeps an absent secret distinct from an empty one', () => {
      expect(validateMcpServer(input()).secret).toBeUndefined();
      expect(validateMcpServer(input({ secret: '' })).secret).toBe('');
      expect(validateMcpServer(input({ secret: 'lin_api_x' })).secret).toBe('lin_api_x');
    });
  });
});

// The disabled Save button and the server's 400 must not disagree, which is
// only true while this runs the real validator rather than a second copy of it.
describe('mcpServerInputProblem', () => {
  it('is null exactly when validateMcpServer accepts', () => {
    expect(mcpServerInputProblem(input())).toBeNull();
    expect(mcpServerInputProblem(input({ url: 'not a url' }))).toMatch(/is not a URL/);
  });
});

describe('the catalog', () => {
  it('has unique handles', () => {
    const handles = MCP_CATALOG.map((e) => e.handle);
    expect(new Set(handles).size).toBe(handles.length);
  });

  // Every entry is something a user can click, so every entry has to survive
  // the validator. A catalog row that cannot be saved is worse than no row.
  it('every entry validates as written', () => {
    for (const entry of MCP_CATALOG) {
      expect(() => validateMcpServer(mcpServerFromCatalog(entry)), entry.handle).not.toThrow();
    }
  });

  // The one name the fleet refuses. GitHub is in the catalog and its handle
  // must not be the reserved word.
  // The fleet reserves `github` for the sandbox's own REST API, so the GitHub
  // entry has to create a server under a different name. Asserted on the
  // RESOLVED name rather than the handle, because that is what gets stored.
  it('no entry would create a server under the reserved name', () => {
    for (const entry of MCP_CATALOG) {
      expect(mcpServerFromCatalog(entry).name, entry.title).not.toBe('github');
    }
  });
});
