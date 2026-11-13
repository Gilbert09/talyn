import { RefreshCw } from 'lucide-react';
import { Button } from '../../ui/button';
import { usePullRequestStore } from '../../../stores/pullRequests';
import { refreshPullRequests } from '../../../hooks/usePullRequestSync';

/**
 * Asks GitHub again for every watched repo and re-reads the list. It sits in
 * the page header, not in a menu: people press it often. The icon spins for
 * every list load, so it also shows a background reload.
 */
export function PrRefreshButton() {
  const loading = usePullRequestStore((s) => s.loading);
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 w-7 p-0"
      onClick={() => void refreshPullRequests()}
      disabled={loading}
      title="Refresh from GitHub"
      aria-label="Refresh from GitHub"
      data-attr="pr-refresh"
    >
      <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
    </Button>
  );
}
