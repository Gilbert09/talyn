import { workbenchesOffered } from '@talyn/shared';
import type { Shortcut } from '../../lib/shortcuts';
import { useNavigationStore, type Route } from '../../stores/navigation';
import { useWorkspaceStore } from '../../stores/workspace';

export const GO_TO_GROUP = 'Go to';

const features = () => useWorkspaceStore.getState().features;
const navigate = (route: Route) => useNavigationStore.getState().navigate(route);

function goTo(id: string, keys: string, label: string, run: () => void, when?: () => boolean): Shortcut {
  // Hidden from the palette's Actions: its Navigate rows show these keys instead.
  return { id: `goto.${id}`, keys, label: `Go to ${label}`, group: GO_TO_GROUP, hidden: true, when, run };
}

/**
 * The "go to" sequences: G, then a letter, opens a page. The labels are the
 * sidebar's, and a page the sidebar hides has a shortcut that does nothing.
 */
export function buildGoToShortcuts(): Shortcut[] {
  return [
    goTo('home', 'g h', 'Home', () => navigate({ view: 'home' })),
    goTo('history', 'g y', 'History', () => navigate({ view: 'history' }), () => workbenchesOffered(features())),
    goTo('my_prs', 'g p', 'Pull requests', () => navigate({ view: 'prs', tab: 'my_prs' })),
    goTo('reviews', 'g r', 'Review requests', () => navigate({ view: 'prs', tab: 'reviews' })),
    goTo('code_reviews', 'g c', 'Code review', () => navigate({ view: 'prs', tab: 'code_reviews' })),
    goTo('merge_queue', 'g m', 'Merge queue', () => navigate({ view: 'prs', tab: 'merge_queue' })),
    goTo('queue', 'g t', 'Tasks', () => navigate({ view: 'prs', tab: 'queue' })),
    goTo('integrations', 'g n', 'Integrations', () => navigate({ view: 'integrations' })),
    goTo('insights', 'g i', 'Insights', () => navigate({ view: 'insights' })),
    goTo('settings', 'g s', 'Settings', () =>
      navigate({ view: 'settings', section: useWorkspaceStore.getState().settingsSection })
    ),
    {
      id: 'help.shortcuts',
      keys: 'shift+/',
      label: 'Show keyboard shortcuts',
      group: 'General',
      hidden: true,
      run: () => navigate({ view: 'settings', section: 'shortcuts' }),
    },
  ];
}

/** The shortcut that opens a palette Navigate row, by the row's key. */
export function goToShortcutIdForNavItem(key: string): string | undefined {
  if (key === 'settings:shortcuts') return 'help.shortcuts';
  if (key === 'integrations' || key.startsWith('integrations:')) return 'goto.integrations';
  if (key.startsWith('prs:')) return `goto.${key.slice(4)}`;
  if (key === 'home' || key === 'history' || key === 'insights') return `goto.${key}`;
  return undefined;
}
