import type { MouseEvent } from 'react';
import { workbenchesOffered } from '@talyn/shared';
import { SquareTerminal } from 'lucide-react';
import type { PRRow } from '../../lib/api';
import { Button } from '../ui/button';
import { useWorkspaceStore } from '../../stores/workspace';
import { openNewWorkbench, prefillFromPr } from './new/openNewWorkbench';

/** Open the new-workbench page aimed at this PR: its repository, its head branch, the link. */
export function openPrInWorkbench(row: Pick<PRRow, 'id' | 'repositoryId' | 'summary'>): void {
  openNewWorkbench(prefillFromPr(row));
}

/**
 * "Open in workbench" for an open PR. Draws nothing when workbenches are not
 * offered to this account, or the PR is no longer open.
 */
export function OpenInWorkbenchButton({
  row,
  variant = 'sheet',
  onOpened,
}: {
  row: PRRow;
  variant?: 'sheet' | 'row';
  onOpened?: () => void;
}) {
  const features = useWorkspaceStore((s) => s.features);
  if (!workbenchesOffered(features) || row.state !== 'open' || row.session) return null;
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    openPrInWorkbench(row);
    onOpened?.();
  };
  const title = 'Open in a session — check out this branch with an agent chat, a diff and a terminal';
  if (variant === 'row') {
    return (
      <button
        type="button"
        data-attr="pr-row-open-workbench"
        onClick={open}
        className="rounded p-1 text-muted-foreground hover:text-foreground"
        title={title}
        aria-label="Open in session"
      >
        <SquareTerminal className="h-3.5 w-3.5" />
      </button>
    );
  }
  return (
    <Button variant="ghost" className="h-7 w-7 p-0" onClick={open} title={title} aria-label="Open in session">
      <SquareTerminal className="h-4 w-4" />
    </Button>
  );
}
