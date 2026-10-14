import { useEffect, useRef, useState } from 'react';
import { FolderKanban, Loader2, Plus, Shuffle, Trash2, Upload } from 'lucide-react';
import type { WorkspaceLogo as WorkspaceLogoData } from '@talyn/shared';
import { api } from '../../../lib/api';
import { downscaleImage } from '../../../lib/imageDownscale';
import { useWorkspaceActions } from '../../../hooks/useApi';
import { useWorkspaceStore } from '../../../stores/workspace';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { Input } from '../../ui/input';
import { SettingRow, SettingsPage, SettingsSection } from '../../ui/settings';
import { WorkspaceLogo } from '../../widgets/WorkspaceLogo';

export function WorkspaceSettings() {
  const { workspaces, currentWorkspaceId, setCreateWorkspaceOpen, setCurrentWorkspace } =
    useWorkspaceStore();
  const { refreshWorkspaces } = useWorkspaceActions();
  const currentWorkspace = workspaces.find((w) => w.id === currentWorkspaceId);

  // Editable name, re-seeded whenever the active workspace changes.
  const [name, setName] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setName(currentWorkspace?.name ?? '');
    setConfirmDelete(false);
  }, [currentWorkspaceId, currentWorkspace?.name]);

  const metaDirty = !!currentWorkspace && name.trim() !== currentWorkspace.name;
  const isOnlyWorkspace = workspaces.length <= 1;

  async function handleSaveMeta() {
    if (!currentWorkspaceId || !name.trim() || !metaDirty) return;
    setSavingMeta(true);
    try {
      await api.workspaces.update(currentWorkspaceId, {
        name: name.trim(),
      });
      await refreshWorkspaces();
    } finally {
      setSavingMeta(false);
    }
  }

  async function handleDelete() {
    if (!currentWorkspaceId || isOnlyWorkspace) return;
    setDeleting(true);
    try {
      await api.workspaces.delete(currentWorkspaceId);
      // Switch to another workspace before the list refreshes so the UI never
      // sits on a deleted id.
      const next = workspaces.find((w) => w.id !== currentWorkspaceId);
      setCurrentWorkspace(next?.id ?? null);
      await refreshWorkspaces();
      // Closed only once the delete has actually happened. It used to close in
      // `finally`, so a failed delete dropped the dialog and left the workspace
      // there with nothing said about why.
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  // ---------- Logo ----------
  const fileRef = useRef<HTMLInputElement>(null);
  const [savingLogo, setSavingLogo] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);

  async function saveLogo(logo: WorkspaceLogoData) {
    if (!currentWorkspaceId) return;
    setSavingLogo(true);
    setLogoError(null);
    try {
      await api.workspaces.update(currentWorkspaceId, { logo });
      await refreshWorkspaces();
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : 'Could not update logo');
    } finally {
      setSavingLogo(false);
    }
  }

  async function handleUploadLogo(file: File) {
    setLogoError(null);
    try {
      const dataUrl = await downscaleImage(file, 256);
      if (dataUrl.length > 512 * 1024) {
        setLogoError('That image is too detailed — try a smaller or simpler one.');
        return;
      }
      await saveLogo({ kind: 'image', dataUrl });
    } catch {
      setLogoError('Could not read that image.');
    }
  }

  return (
    <SettingsPage title="Workspace" description="Configure your current workspace">
      {currentWorkspace ? (
        <>
          <SettingsSection title="General">
            <div className="space-y-2 px-3 py-2 text-[13px]">
              <label className="block">Workspace Name</label>
              <div className="flex items-center gap-2">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={savingMeta}
                />
                <Button
                  size="sm"
                  className="shrink-0"
                  onClick={handleSaveMeta}
                  disabled={!metaDirty || !name.trim() || savingMeta}
                >
                  {savingMeta ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Save changes'}
                </Button>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection title="Logo">
            <div className="flex items-center gap-3 px-3 py-2">
              <WorkspaceLogo
                logo={currentWorkspace.logo}
                fallbackSeed={currentWorkspace.id}
                size={48}
              />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void saveLogo({ kind: 'identicon', seed: crypto.randomUUID() })}
                    disabled={savingLogo}
                    title="Generate a new identicon"
                  >
                    <Shuffle className="w-3.5 h-3.5" />
                    Shuffle
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileRef.current?.click()}
                    disabled={savingLogo}
                  >
                    <Upload className="w-3.5 h-3.5" />
                    Upload image
                  </Button>
                  {savingLogo && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handleUploadLogo(file);
                      e.target.value = ''; // allow re-picking the same file
                    }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Uploads are downscaled to 256px. Shuffle to go back to a generated logo.
                </p>
                {logoError && <p className="text-xs text-destructive">{logoError}</p>}
              </div>
            </div>
          </SettingsSection>

          <SettingsSection title="Delete workspace">
            <SettingRow
              label="Delete workspace"
              description="Permanently removes this workspace and its watched repos, tasks, and integration credentials. This cannot be undone."
            >
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmDelete(true)}
                disabled={isOnlyWorkspace}
                title={
                  isOnlyWorkspace
                    ? 'You need at least one workspace'
                    : 'Delete this workspace'
                }
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete workspace
              </Button>
            </SettingRow>
          </SettingsSection>

          <ConfirmDialog
            open={confirmDelete}
            title={`Delete "${currentWorkspace.name}"?`}
            description={
              <>
                This permanently removes the workspace and its watched repos, tasks and
                integration credentials. It cannot be undone.
              </>
            }
            confirmLabel="Delete workspace"
            busy={deleting}
            onConfirm={() => void handleDelete()}
            onCancel={() => setConfirmDelete(false)}
          />
        </>
      ) : (
        <div className="flex flex-col items-center gap-2 py-16 text-center text-[13px] text-muted-foreground">
          <FolderKanban className="h-6 w-6" />
          <p className="font-medium text-foreground">No Workspace Selected</p>
          <p>Create or select a workspace to configure settings</p>
          <Button size="sm" className="mt-2" onClick={() => setCreateWorkspaceOpen(true)}>
            <Plus className="w-3.5 h-3.5" />
            Create Workspace
          </Button>
        </div>
      )}
    </SettingsPage>
  );
}
