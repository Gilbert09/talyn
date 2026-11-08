import { Copy, ExternalLink } from 'lucide-react';
import { APP_VERSION, BUILD_COMMIT, commitUrl } from '../../lib/env';
import { openExternal } from '../../lib/openExternal';
import { toast } from '../../stores/toast';
import { Button } from '../ui/button';
import { Card } from '../ui/card';

/** Settings → Developer: which build is running, with a link to its commit. */
export function BuildInfo({ commit = BUILD_COMMIT }: { commit?: string | null }) {
  const copy = async () => {
    if (!commit) return;
    try {
      await navigator.clipboard.writeText(commit);
      toast.success('Commit SHA copied');
    } catch {
      toast.error("Couldn't copy the commit SHA");
    }
  };

  return (
    <section className="space-y-2">
      <h4 className="font-medium">Build</h4>
      <Card className="divide-y divide-border/50 px-3">
        <div className="flex items-center justify-between gap-3 py-2 text-sm">
          <span>Version</span>
          <span className="font-mono text-xs text-muted-foreground" data-testid="build-version">
            {APP_VERSION}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3 py-2 text-sm">
          <span>Commit</span>
          {commit ? (
            <span className="flex items-center gap-2">
              <a
                href={commitUrl(commit)}
                title={commit}
                onClick={(e) => {
                  e.preventDefault();
                  void openExternal(commitUrl(commit));
                }}
                className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
                data-testid="build-commit-link"
              >
                {commit.slice(0, 7)}
                <ExternalLink className="h-3 w-3" />
              </a>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                title="Copy the full commit SHA"
                aria-label="Copy the full commit SHA"
                onClick={() => void copy()}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </span>
          ) : (
            <span className="text-xs text-muted-foreground" data-testid="build-commit-unknown">
              Unknown
            </span>
          )}
        </div>
      </Card>
    </section>
  );
}
