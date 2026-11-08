import { mcpServersOffered, privateRoutesOffered, workbenchesOffered, type Features } from '@talyn/shared';
import type { ComposerLink } from '../components/workbench/ComposerPopover';
import type { Route } from '../stores/navigation';

export interface ComposerSettingsLink extends ComposerLink {
  route: Route;
  /** More words that find the link. */
  keywords: string;
}

/** The settings pages that the composer's `/` list offers, for the features this account has. */
export function composerSettingsLinks(features: Features | null): ComposerSettingsLink[] {
  const links: ComposerSettingsLink[] = [];
  if (mcpServersOffered(features)) {
    links.push({
      id: 'mcp-servers',
      label: 'MCP servers',
      description: 'Connect tool servers for the agents',
      route: { view: 'settings', section: 'mcpServers' },
      keywords: 'mcp tools',
    });
  }
  links.push(
    {
      id: 'agents',
      label: 'Agents',
      description: 'Claude and Codex accounts, and where agents run',
      route: { view: 'settings', section: 'agents' },
      keywords: 'agents accounts claude codex',
    },
    {
      id: 'skills',
      label: 'Skills',
      description: 'Manage workspace and repository skills',
      route: { view: 'settings', section: 'skills' },
      keywords: 'skills commands',
    },
    {
      id: 'instructions',
      label: 'Instructions',
      description: 'Edit the instructions that every agent reads',
      route: { view: 'settings', section: 'instructions' },
      keywords: 'claude.md agents.md prompt',
    },
  );
  if (workbenchesOffered(features)) {
    links.push(
      {
        id: 'memory',
        label: 'Memory',
        description: 'Notes that sessions save and read',
        route: { view: 'settings', section: 'memory' },
        keywords: 'memory notes',
      },
      {
        id: 'sandbox-setup',
        label: 'Sandbox setup',
        description: 'Steps that prepare each new sandbox',
        route: { view: 'settings', section: 'sandboxSetup' },
        keywords: 'sandbox setup install',
      },
    );
  }
  if (privateRoutesOffered(features)) {
    links.push({
      id: 'private-routes',
      label: 'Private routes',
      description: 'Let sessions reach private networks',
      route: { view: 'settings', section: 'privateRoutes' },
      keywords: 'private routes tailnet network',
    });
  }
  links.push({
    id: 'integrations',
    label: 'Integrations',
    description: 'Connect other services',
    route: { view: 'settings', section: 'integrations' },
    keywords: 'integrations',
  });
  return links;
}

/** The links whose id, label or keywords contain the query. */
export function matchComposerLinks<T extends ComposerSettingsLink>(links: T[], query: string): T[] {
  const q = query.toLowerCase();
  return links.filter((link) => [link.id, link.label, link.keywords].some((text) => text.toLowerCase().includes(q)));
}
