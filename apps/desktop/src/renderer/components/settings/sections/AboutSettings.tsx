import { useEffect, useState } from 'react';
import { Download, Github, Globe, Loader2, Sparkles } from 'lucide-react';
import { highlightsForSurface } from '@talyn/shared';
import type { UpdaterEvent } from '../../../../main/updaterEvents';
import { api } from '../../../lib/api';
import { openExternal } from '../../../lib/openExternal';
import { cn } from '../../../lib/utils';
import { toast } from '../../../stores/toast';
import { useWorkspaceStore } from '../../../stores/workspace';
import { Button } from '../../ui/button';
import { Card } from '../../ui/card';
import { SettingsPage } from '../../ui/settings';

const REPO_URL = 'https://github.com/Gilbert09/talyn';
const SITE_URL = 'https://talyn.dev';

function openRepo() {
  if (window.electron?.auth?.openExternal) {
    void window.electron.auth.openExternal(REPO_URL);
  } else {
    window.open(REPO_URL, '_blank');
  }
}

export function AboutSettings() {
  const [version, setVersion] = useState<string | null>(null);
  const [loadingNotes, setLoadingNotes] = useState(false);
  const openWhatsNew = useWorkspaceStore((s) => s.openWhatsNew);
  const [status, setStatus] = useState<UpdaterEvent | null>(null);
  const [checking, setChecking] = useState(false);
  // Set when a check runs in dev / an unpackaged build, where auto-update
  // can't operate and no events fire.
  const [unsupported, setUnsupported] = useState(false);
  const [channel, setChannel] = useState<'stable' | 'nightly'>('stable');

  useEffect(() => {
    window.electron?.app
      ?.getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
    window.electron?.updater
      ?.getChannel()
      .then(setChannel)
      .catch(() => {});
  }, []);

  const switchChannel = async (next: 'stable' | 'nightly') => {
    if (next === channel) return;
    setChannel(next); // optimistic — the main process write is near-infallible
    try {
      const applied = await window.electron?.updater?.setChannel(next);
      if (applied) setChannel(applied);
    } catch {
      setChannel(channel);
    }
  };

  useEffect(() => {
    return window.electron?.updater?.onEvent((e) => {
      setStatus(e);
      // A terminal event ends the in-flight check spinner.
      if (e.kind !== 'checking' && e.kind !== 'progress') setChecking(false);
    });
  }, []);

  const handleCheck = async () => {
    setUnsupported(false);
    setChecking(true);
    setStatus({ kind: 'checking' });
    try {
      const res = await window.electron?.updater?.check();
      if (res && res.started === false) {
        setUnsupported(true);
        setChecking(false);
        setStatus(null);
      }
    } catch {
      setChecking(false);
    }
  };

  // The full changelog, not just what's new since last launch — this is the
  // "go and look" path, so an empty `since` is the point. It is also the only
  // way to see the modal on a local build, which reports its version as `dev`.
  const showWhatsNew = async () => {
    setLoadingNotes(true);
    try {
      const entries = await api.releaseNotes.list();
      openWhatsNew(highlightsForSurface(entries, 'desktop'));
    } catch {
      toast.error("Couldn't load release notes");
    } finally {
      setLoadingNotes(false);
    }
  };

  const downloaded = status?.kind === 'downloaded';
  const downloading =
    status?.kind === 'available' || status?.kind === 'progress';

  let statusText: string | null = null;
  if (unsupported) {
    statusText = 'Auto-update only runs in the installed app, not in development.';
  } else if (status?.kind === 'checking') {
    statusText = 'Checking for updates…';
  } else if (status?.kind === 'not-available') {
    statusText = "You're on the latest version.";
  } else if (status?.kind === 'available') {
    statusText = `Update ${status.version} found — downloading…`;
  } else if (status?.kind === 'progress') {
    statusText = `Downloading update… ${status.percent}%`;
  } else if (status?.kind === 'downloaded') {
    statusText = `Update ${status.version} downloaded and ready to install.`;
  } else if (status?.kind === 'error') {
    statusText = `Couldn't check for updates: ${status.message}`;
  }

  return (
    <SettingsPage title="About" description="Version information and software updates">
      <Card className="p-3 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h4 className="text-[13px] font-semibold">Talyn</h4>
            <p className="text-xs text-muted-foreground mt-0.5">
              Version {version ?? '—'}
            </p>
          </div>
          {downloaded ? (
            <Button
              size="sm"
              onClick={() => window.electron?.updater?.quitAndInstall()}
            >
              <Download className="w-3.5 h-3.5" />
              Restart to install
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={handleCheck}
              disabled={checking || downloading}
            >
              {checking || downloading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                'Check for updates'
              )}
            </Button>
          )}
        </div>

        {statusText && (
          <p
            className={cn(
              'text-xs',
              status?.kind === 'error'
                ? 'text-destructive'
                : 'text-muted-foreground'
            )}
          >
            {statusText}
          </p>
        )}

        <div className="border-t pt-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[13px] font-medium">Update channel</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {channel === 'nightly'
                  ? 'Nightly — every build as it lands. Expect rough edges.'
                  : 'Stable — tested, tagged releases. Recommended.'}
              </p>
            </div>
            <div className="flex rounded-md border p-0.5">
              {(['stable', 'nightly'] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => void switchChannel(c)}
                  className={cn(
                    'rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors',
                    channel === c
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="border-t pt-3 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => void showWhatsNew()}
            disabled={loadingNotes}
            className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground disabled:opacity-60"
          >
            {loadingNotes ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
            What&rsquo;s new
          </button>
          <button
            type="button"
            onClick={() => void openExternal(SITE_URL)}
            className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <Globe className="w-3.5 h-3.5" />
            talyn.dev
          </button>
          <button
            type="button"
            onClick={openRepo}
            className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <Github className="w-3.5 h-3.5" />
            View source on GitHub
          </button>
        </div>
      </Card>
    </SettingsPage>
  );
}
