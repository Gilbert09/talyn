import React, { useEffect, useState } from 'react';
import { SANDBOX_SIZES, type RepositorySandboxSizeResponse, type SandboxSizeSetting } from '@talyn/shared';
import { api } from '../../lib/api';
import { toast } from '../../stores/toast';
import { Select } from '../ui/select';

/** The size of the sandbox a session on this repository gets. Hidden for an account without sessions. */
export function RepoSandboxSize({ repositoryId, hideLabel = false, onInfoChange }: { repositoryId: string; hideLabel?: boolean; onInfoChange?: (info: RepositorySandboxSizeResponse) => void }) {
  const [info, setInfo] = useState<RepositorySandboxSizeResponse | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    api.repositories.sandboxSize.get(repositoryId).then((next) => { if (live) { setInfo(next); onInfoChange?.(next); } }).catch(() => undefined);
    return () => { live = false; };
  }, [repositoryId]);

  if (!info) return null;

  const change = async (value: SandboxSizeSetting) => {
    setSaving(true);
    try {
      const next = await api.repositories.sandboxSize.set(repositoryId, value);
      setInfo(next);
      onInfoChange?.(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the sandbox size.');
    } finally {
      setSaving(false);
    }
  };

  const hint = info.setting === 'auto'
    ? `Auto picks ${SANDBOX_SIZES[info.effective].label}${info.detected ? `: ${info.detected.reason}` : '.'}`
    : info.detected?.reason ?? null;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <label htmlFor={`sandbox-size-${repositoryId}`} className={hideLabel ? 'sr-only' : 'text-xs text-muted-foreground shrink-0'}>
          Sandbox size
        </label>
        <Select
          id={`sandbox-size-${repositoryId}`}
          className="h-8 text-xs"
          value={info.setting}
          disabled={saving}
          onChange={(e) => void change(e.target.value as SandboxSizeSetting)}
        >
          <option value="auto">Auto</option>
          {Object.entries(SANDBOX_SIZES).map(([size, config]) => (
            <option key={size} value={size}>{config.label} — {config.hint}</option>
          ))}
        </Select>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
