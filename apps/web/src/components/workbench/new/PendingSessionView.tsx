import { useEffect } from 'react';
import { ImageIcon, Loader2 } from 'lucide-react';
import { endQuotesAtPlainLines } from '@talyn/shared';
import { renderMarkdownish } from '../../../lib/markdown';
import type { NewWorkbenchSpec } from './useCreateWorkbench';

/**
 * The session screen while its create request is in flight. The page switches
 * here on Enter, so the person sees their session at once and not a composer
 * that waits for the backend. The real session replaces it when the row exists.
 */
export function PendingSessionView({ spec }: { spec: NewWorkbenchSpec }) {
  const thread = spec.kind === 'thread';
  const prompt = spec.prompt.trim();
  const images = spec.attachments?.length ?? 0;
  const branch = spec.branch?.trim() || spec.baseBranch?.trim();

  // Load the session page's code now, so it does not add a wait when the row arrives.
  useEffect(() => {
    void import('../../../pages/WorkbenchPage').catch(() => undefined);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col" data-attr="pending-session-view">
      <div className="min-w-0 border-b px-3 py-1.5">
        <div className="flex h-7 min-w-0 items-center gap-2">
          <h1 className="min-w-0 truncate text-sm font-semibold">{thread ? 'New thread' : 'New session'}</h1>
          {!thread && spec.repoFullName && (
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {spec.repoFullName}
              {branch ? ` · ${branch}` : ''}
            </span>
          )}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto px-4 py-4 text-sm text-foreground">
          {(prompt || images > 0) && (
            <div className="flex justify-end">
              <div className="max-w-[85%] space-y-1">
                <div className="rounded-lg bg-muted px-3 py-2 text-[13px] text-foreground [overflow-wrap:anywhere]">
                  {prompt && renderMarkdownish(endQuotesAtPlainLines(prompt), 'surface')}
                  {images > 0 && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <ImageIcon className="h-3.5 w-3.5" />
                      {images === 1 ? '1 image' : `${images} images`}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          <div
            role="status"
            className="mt-6 flex items-center justify-center gap-2 text-xs text-muted-foreground"
            data-attr="pending-session-status"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {thread ? 'Creating the thread…' : 'Creating the session…'}
          </div>
        </div>
        <div className="border-t bg-background px-3 pb-3 pt-2">
          <div className="rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-muted-foreground opacity-60">
            You can write more when the {thread ? 'thread' : 'session'} opens.
          </div>
        </div>
      </div>
    </div>
  );
}
