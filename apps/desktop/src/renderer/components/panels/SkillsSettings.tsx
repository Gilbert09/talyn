// Settings → Skills: manage the workspace's Talyn (platform) skills, see
// what's on this machine (~/.claude/skills) with a one-click "Save to Talyn",
// and browse the skills discovered in each watched repo.

import React, { useMemo, useState } from 'react';
import {
  Check,
  FolderGit2,
  Laptop,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import type { PlatformSkill, SkillSummary } from '@talyn/shared';
import { api } from '../../lib/api';
import { toast } from '../../stores/toast';
import { useWorkspaceStore } from '../../stores/workspace';
import { useSkills } from '../../hooks/useSkills';
import { toLocalSkillSummaries } from '../../lib/skills';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { SettingsSection, SettingsSelect } from '../ui/settings';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';

interface SkillDraft {
  id?: string;
  name: string;
  description: string;
  content: string;
}

export function SkillsSettings() {
  const { currentWorkspaceId, repositories } = useWorkspaceStore();
  const workspaceRepos = useMemo(
    () => repositories.filter((r) => r.workspaceId === currentWorkspaceId),
    [repositories, currentWorkspaceId]
  );
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const repoId = selectedRepoId ?? workspaceRepos[0]?.id ?? null;
  const { skills, localFiles, repoStatus, refreshing, refresh } = useSkills(
    currentWorkspaceId,
    repoId
  );

  const platformSkills = skills.filter((s) => s.source === 'platform');
  const repoSkills = skills.filter((s) => s.source === 'repo');
  const localSkills = useMemo(() => toLocalSkillSummaries(localFiles), [localFiles]);

  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SkillSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [importingPath, setImportingPath] = useState<string | null>(null);

  async function saveDraft() {
    if (!currentWorkspaceId || !draft) return;
    if (!draft.name.trim() || !draft.content.trim()) {
      toast.error('Name and content are required');
      return;
    }
    setSaving(true);
    try {
      if (draft.id) {
        await api.skills.update(draft.id, {
          name: draft.name,
          description: draft.description,
          content: draft.content,
        });
        toast.success(`Updated "${draft.name}"`);
      } else {
        await api.skills.create({
          workspaceId: currentWorkspaceId,
          name: draft.name,
          description: draft.description,
          content: draft.content,
        });
        toast.success(`Created "${draft.name}"`);
      }
      setDraft(null);
      await refresh();
    } catch (err) {
      toast.error(
        draft.id ? 'Could not update skill' : 'Could not create skill',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setSaving(false);
    }
  }

  async function editSkill(skill: SkillSummary) {
    if (!skill.id) return;
    try {
      const full: PlatformSkill = await api.skills.get(skill.id);
      setDraft({
        id: full.id,
        name: full.name,
        description: full.description,
        content: full.content,
      });
    } catch (err) {
      toast.error('Could not load skill', err instanceof Error ? err.message : undefined);
    }
  }

  /** Perform the delete the dialog is asking about. */
  async function deleteSkill() {
    const skill = pendingDelete;
    if (!skill?.id) return;
    setDeleting(true);
    try {
      await api.skills.remove(skill.id);
      toast.success(`Deleted "${skill.name}"`);
      // Closed only on success: a failure leaves the dialog up beside the
      // error rather than dropping the user back with nothing explained.
      setPendingDelete(null);
      await refresh();
    } catch (err) {
      toast.error('Could not delete skill', err instanceof Error ? err.message : undefined);
    } finally {
      setDeleting(false);
    }
  }

  async function saveLocalToTalyn(skill: SkillSummary) {
    if (!currentWorkspaceId || !skill.localPath) return;
    const file = localFiles.find((f) => f.path === skill.localPath);
    if (!file?.content) {
      toast.error('Skill file is too large to save');
      return;
    }
    setImportingPath(skill.localPath);
    try {
      await api.skills.create({
        workspaceId: currentWorkspaceId,
        name: skill.name,
        description: skill.description,
        content: file.content,
        sourceInfo: { importedFrom: 'local', originPath: skill.localPath },
      });
      toast.success(`Saved "${skill.name}" to Talyn`);
      await refresh();
    } catch (err) {
      toast.error(
        `Couldn't save "${skill.name}"`,
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setImportingPath(null);
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">
        Agent skills (SKILL.md) you can run on a pull request with a cloud task — from this
        workspace, this machine, or the PR&apos;s repo.
      </p>

      {/* Talyn (platform) skills */}
      <SettingsSection
        title="Talyn skills"
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDraft({ name: '', description: '', content: '' })}
          >
            <Plus className="h-3.5 w-3.5" /> New skill
          </Button>
        }
      >
        {platformSkills.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            No skills saved to Talyn yet. Create one, or save a local skill below.
          </p>
        ) : (
          platformSkills.map((skill) => (
            <div
              key={skill.key}
              className="flex items-center gap-2 px-3 py-2 hover:bg-muted/60"
            >
              <Sparkles className="h-3.5 w-3.5 shrink-0 text-violet-500" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{skill.name}</div>
                {skill.description && (
                  <div className="truncate text-xs text-muted-foreground">
                    {skill.description}
                  </div>
                )}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0"
                title="Edit"
                onClick={() => void editSkill(skill)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-red-600"
                title="Delete"
                onClick={() => setPendingDelete(skill)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))
        )}
      </SettingsSection>

      {/* Local skills */}
      <SettingsSection
        title="Local skills (this machine)"
        description={
          <>
            Read from <code>~/.claude/skills</code> — ready to run on any PR straight from the
            picker, nothing to set up. Saving one to Talyn is optional and only makes it
            available from other machines.
          </>
        }
      >
        {localSkills.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">No local skills found.</p>
        ) : (
          localSkills.map((skill) => {
            const alreadyOnTalyn = platformSkills.some((p) => p.name === skill.name);
            return (
              <div
                key={skill.key}
                className="group flex items-center gap-2 px-3 py-2 hover:bg-muted/60"
              >
                <Laptop className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{skill.name}</div>
                  {skill.description && (
                    <div className="truncate text-xs text-muted-foreground">
                      {skill.description}
                    </div>
                  )}
                </div>
                {alreadyOnTalyn ? (
                  <span
                    className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                    title="Also saved to Talyn"
                  >
                    <Check className="h-3 w-3" /> On Talyn
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
                    disabled={importingPath === skill.localPath}
                    title="Optional — copies this skill to Talyn so it's available from other machines"
                    onClick={() => void saveLocalToTalyn(skill)}
                  >
                    {importingPath === skill.localPath ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Upload className="h-3 w-3" />
                    )}
                    Save to Talyn
                  </Button>
                )}
              </div>
            );
          })
        )}
      </SettingsSection>

      {/* Repo skills */}
      <SettingsSection
        title="Repo skills"
        actions={
          <div className="flex items-center gap-2">
            {workspaceRepos.length > 1 && (
              <SettingsSelect
                value={repoId ?? ''}
                onChange={(e) => setSelectedRepoId(e.target.value || null)}
                className="max-w-[240px]"
              >
                {workspaceRepos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.fullName}
                  </option>
                ))}
              </SettingsSelect>
            )}
            {workspaceRepos.length === 1 && (
              <span className="text-xs text-muted-foreground">{workspaceRepos[0].fullName}</span>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              title="Re-fetch from GitHub"
              disabled={refreshing || !repoId}
              onClick={() => void refresh({ refreshRepo: true })}
            >
              {refreshing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        }
      >
        {workspaceRepos.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            No repositories in this workspace.
          </p>
        ) : repoStatus === 'error' ? (
          <p className="px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            Couldn&apos;t load skills from GitHub — try refreshing.
          </p>
        ) : repoSkills.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            No skills in this repo (looked in <code>.claude/skills</code> on the default branch).
          </p>
        ) : (
          repoSkills.map((skill) => (
            <div key={skill.key} className="flex items-center gap-2 px-3 py-2 hover:bg-muted/60">
              <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">{skill.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {skill.description || skill.repoPath}
                </div>
              </div>
            </div>
          ))
        )}
      </SettingsSection>

      {/* Create / edit dialog */}
      {draft && (
        <Dialog open onOpenChange={(o) => !o && setDraft(null)}>
          <DialogContent className="max-w-2xl" onClose={() => setDraft(null)}>
            <DialogHeader>
              <DialogTitle>{draft.id ? 'Edit skill' : 'New skill'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Name</label>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="pr-review"
                  className="mt-1"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Description</label>
                <Input
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="What this skill does, shown in the picker"
                  className="mt-1"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  Content (SKILL.md)
                </label>
                <Textarea
                  value={draft.content}
                  onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                  placeholder={'---\nname: pr-review\ndescription: …\n---\n\nInstructions…'}
                  className="mt-1 h-64 font-mono text-xs"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={() => void saveDraft()} disabled={saving}>
                {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {draft.id ? 'Save changes' : 'Create skill'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this skill?"
        description={
          <>
            <span className="font-medium text-foreground">{pendingDelete?.name}</span> is removed
            from this workspace. Tasks that already ran with it are unaffected.
          </>
        }
        busy={deleting}
        onConfirm={() => void deleteSkill()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
