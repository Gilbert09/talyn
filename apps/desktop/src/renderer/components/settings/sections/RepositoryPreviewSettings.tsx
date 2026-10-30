import { useEffect, useRef, useState } from 'react';
import { workbenchesOffered, type RepositoryPreviewChoice, type RepositoryPreviewResponse } from '@talyn/shared';
import { api } from '../../../lib/api';
import { useWorkspaceStore } from '../../../stores/workspace';

export function RepositoryPreviewSettings({ repositoryId, repoName, onConfigChange }: { repositoryId: string; repoName: string; onConfigChange?: (config: RepositoryPreviewResponse) => void }) {
  const enabled = useWorkspaceStore((s) => workbenchesOffered(s.features));
  const [config, setConfig] = useState<RepositoryPreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(config);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  current.current = config;

  useEffect(() => {
    let cancelled = false;
    setConfig(null);
    if (enabled) void api.repositories.preview.get(repositoryId).then((value) => {
      if (!cancelled) { setConfig(value); onConfigChange?.(value); }
    }).catch((err) => { if (!cancelled) setError(String(err)); });
    return () => { cancelled = true; };
  }, [enabled, repositoryId]);

  if (!enabled) return null;
  const update = (change?: RepositoryPreviewChoice) => {
    setBusy(true);
    setError(null);
    const operation = queue.current.catch(() => undefined).then(async () => {
      const user = current.current?.user ?? {};
      const value = change
        ? await api.repositories.preview.patch(repositoryId, {
          ...user, ...change,
          ...(change.coder ? { coder: { ...user.coder, ...change.coder } } : {}),
        })
        : await api.repositories.preview.detect(repositoryId);
      current.current = value;
      setConfig(value);
      onConfigChange?.(value);
      window.dispatchEvent(new Event('repository-preview-changed'));
    });
    queue.current = operation;
    void operation.catch((err) => setError(err instanceof Error ? err.message : String(err))).finally(() => {
      if (queue.current === operation) setBusy(false);
    });
  };
  const inputClass = 'min-w-0 flex-1 rounded border border-input bg-background px-2 py-1 text-xs text-foreground';
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        {config && <select
          aria-label={`Preview target for ${repoName}`}
          data-attr="settings-repo-preview-target"
          className={inputClass}
          value={config.user?.target ?? 'auto'}
          disabled={busy}
          onChange={(event) => update({ target: event.target.value as RepositoryPreviewChoice['target'] })}
        >
          <option value="auto">Auto</option><option value="sandbox">Sandbox</option><option value="coder">Coder</option><option value="off">Off</option>
        </select>}
        <button type="button" data-attr="settings-repo-preview-detect" className="rounded border px-2 py-1 hover:bg-accent disabled:opacity-50" disabled={busy} onClick={() => update()}>Detect again</button>
      </div>
      {config?.reasons.map((reason) => <p key={reason} className="text-muted-foreground">Detected: {reason}</p>)}
      {config?.target === 'coder' && (['url', 'workspace', 'checkout', 'run'] as const).map((field) => (
        <label key={`${field}:${config.coder?.[field] ?? ''}`} className="flex items-center gap-2">
          <span className="w-24 shrink-0">{({ url: 'Coder URL', workspace: 'Workspace', checkout: 'Checkout', run: 'Run command' })[field]}</span>
          <input
            className={inputClass}
            aria-label={`Coder ${field} for ${repoName}`}
            defaultValue={config.coder?.[field] ?? ''}
            placeholder={field === 'checkout' ? `~/${repoName.split('/').pop()}` : undefined}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value !== (config.coder?.[field] ?? '')) update({ coder: { [field]: value } });
            }}
          />
        </label>
      ))}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  );
}
