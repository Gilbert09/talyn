import { Copy, ExternalLink } from 'lucide-react';
import { appVersion, buildCommit, commitUrl } from '../../../lib/appVersion';
import { openExternal } from '../../../lib/openExternal';
import { toast } from '../../../stores/toast';
import { Button } from '../../ui/button';
import { SettingRow, SettingsSection } from '../../ui/settings';

/** Settings → Developer: which build is running, with a link to its commit. */
export function BuildInfo() {
  const sha = buildCommit();

  const copy = async () => {
    if (!sha) return;
    try {
      await navigator.clipboard.writeText(sha);
      toast.success('Commit SHA copied');
    } catch {
      toast.error("Couldn't copy the commit SHA");
    }
  };

  return (
    <SettingsSection title="Build">
      <SettingRow label="Version">
        <span className="font-mono text-xs text-muted-foreground" data-testid="build-version">
          {appVersion()}
        </span>
      </SettingRow>
      <SettingRow label="Commit">
        {sha ? (
          <>
            <a
              href={commitUrl(sha)}
              title={sha}
              onClick={(e) => {
                e.preventDefault();
                void openExternal(commitUrl(sha));
              }}
              className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
              data-testid="build-commit-link"
            >
              {sha.slice(0, 7)}
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
          </>
        ) : (
          <span className="text-xs text-muted-foreground" data-testid="build-commit-unknown">
            Unknown
          </span>
        )}
      </SettingRow>
    </SettingsSection>
  );
}
