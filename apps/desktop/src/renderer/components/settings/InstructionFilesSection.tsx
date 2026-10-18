import { useEffect, useState } from 'react';
import {
  instructionFileTooLargeMessage,
  MAX_WORKBENCH_INSTRUCTION_BYTES,
  type WorkbenchInstructionCandidate,
  type WorkbenchInstructionFile,
} from '@talyn/shared';
import { api } from '../../lib/api';
import {
  mergeInstructionRows,
  uploadChangedInstructionFiles,
  uploadInstructionFile,
  type InstructionRow,
  type InstructionStatus,
} from '../../lib/instructionFiles';
import { getWorkbenchBridge } from '../../lib/workbenchBridge';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toast';
import { useWorkspaceStore } from '../../stores/workspace';
import { Button } from '../ui/button';
import { SettingRow, SettingsSection } from '../ui/settings';

const INTRO =
  'Use instruction files from this Mac in sandbox sessions. Files you switch on are uploaded to Talyn and copied into the sandbox before each turn. Local sessions already read them from this Mac.';

const STATUS_LABEL: Record<Exclude<InstructionStatus, 'off'>, string> = {
  synced: 'Synced',
  changed: 'Changed on this Mac',
  missing: 'Not on this Mac',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

const baseName = (p: string) => p.split('/').pop() || p;

function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        checked ? 'bg-primary' : 'bg-muted',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

function AgentBadge({ agent }: { agent: 'claude' | 'codex' }) {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      {agent === 'codex' ? 'Codex' : 'Claude'}
    </span>
  );
}

function InstructionFileRow({
  row,
  busy,
  onToggle,
  onRemove,
}: {
  row: InstructionRow;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const { local, stored } = row;
  const path = local?.displayPath ?? stored?.sourcePath ?? row.key;
  const agent = local?.agent ?? stored?.agent ?? 'claude';
  const repo = local?.repoFullName ?? stored?.repoFullName ?? null;
  const bytes = local?.bytes ?? stored?.bytes ?? 0;
  const tooLarge = Boolean(local && local.bytes > MAX_WORKBENCH_INSTRUCTION_BYTES);
  const status = row.status === 'off' ? null : STATUS_LABEL[row.status];

  return (
    <SettingRow
      label={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[11px]" title={path}>
            {path}
          </span>
          <AgentBadge agent={agent} />
        </span>
      }
      description={
        <>
          <span>
            {formatBytes(bytes)}
            {repo ? ` · ${repo} sessions only` : ''}
            {status ? ` · ${status}` : ''}
          </span>
          {local && local.imports.length > 0 ? (
            <span className="mt-0.5 block" title={local.imports.join('\n')}>
              Includes {local.imports.map(baseName).join(', ')}
            </span>
          ) : null}
          {local && local.missingImports.length > 0 ? (
            <span className="mt-0.5 block text-amber-600 dark:text-amber-400">
              Could not find {local.missingImports.join(', ')}. The import stays as text.
            </span>
          ) : null}
          {tooLarge && local ? (
            <span className="mt-0.5 block text-destructive">{instructionFileTooLargeMessage(local.bytes)}</span>
          ) : null}
        </>
      }
    >
      {local ? (
        <Switch
          checked={row.enabled}
          disabled={busy || (tooLarge && !row.enabled)}
          label={`Use ${path} in sandboxes`}
          onChange={onToggle}
        />
      ) : (
        <Button variant="outline" size="sm" disabled={busy} onClick={onRemove}>
          Remove
        </Button>
      )}
    </SettingRow>
  );
}

/**
 * "Your instructions": the user's CLAUDE.md, rules, AGENTS.md and per-repo
 * CLAUDE.local.md, switched on one by one for sandbox sessions.
 *
 * Switching a file off PUTs `enabled: false` rather than deleting it: the
 * server drops the text but keeps the row, so the next turn in each sandbox
 * removes the copy it has. A deleted row would leave that copy behind.
 */
export function InstructionFilesSection() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const bridge = getWorkbenchBridge();
  const hasBridge = Boolean(bridge?.instructionFiles);
  const [local, setLocal] = useState<WorkbenchInstructionCandidate[] | null>(null);
  const [stored, setStored] = useState<WorkbenchInstructionFile[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const read = getWorkbenchBridge()?.instructionFiles;
    if (!workspaceId || !read) return undefined;
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const [found, list] = await Promise.all([read(), api.workbenches.instructions.list(workspaceId)]);
        if (cancelled) return;
        setLocal(found);
        setStored(list);
        const synced = await uploadChangedInstructionFiles(workspaceId, found, list);
        if (cancelled) return;
        setStored(synced.stored);
        if (synced.failed > 0) toast.error('Could not upload your changed instruction files');
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not read your instruction files');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const withBusy = async (key: string, work: () => Promise<void>) => {
    setBusy((b) => new Set(b).add(key));
    try {
      await work();
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(key);
        return next;
      });
    }
  };

  const replaceStored = (file: WorkbenchInstructionFile) =>
    setStored((list) => [...list.filter((s) => s.key !== file.key), file]);

  const toggle = (row: InstructionRow, enabled: boolean) => {
    if (!workspaceId || !row.local) return;
    const file = row.local;
    if (enabled && file.bytes > MAX_WORKBENCH_INSTRUCTION_BYTES) {
      toast.error(instructionFileTooLargeMessage(file.bytes));
      return;
    }
    void withBusy(row.key, async () => {
      try {
        replaceStored(await uploadInstructionFile(workspaceId, file, enabled));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not save this file');
      }
    });
  };

  const remove = (row: InstructionRow) => {
    if (!workspaceId) return;
    void withBusy(row.key, async () => {
      try {
        await api.workbenches.instructions.remove(workspaceId, row.key);
        setStored((list) => list.filter((s) => s.key !== row.key));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not remove this file');
      }
    });
  };

  const rows = local ? mergeInstructionRows(local, stored) : [];

  return (
    <SettingsSection title="Your instructions" description={INTRO}>
      {!hasBridge ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">This needs the Talyn desktop app.</p>
      ) : error ? (
        <p role="alert" className="px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : local === null ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">Looking for instruction files…</p>
      ) : rows.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          No instruction files on this Mac. Talyn looks for ~/.claude/CLAUDE.md, ~/.claude/rules, ~/.codex/AGENTS.md
          and CLAUDE.local.md in the repositories you have chosen a folder for.
        </p>
      ) : (
        rows.map((row) => (
          <InstructionFileRow
            key={row.key}
            row={row}
            busy={busy.has(row.key)}
            onToggle={(enabled) => toggle(row, enabled)}
            onRemove={() => remove(row)}
          />
        ))
      )}
    </SettingsSection>
  );
}
