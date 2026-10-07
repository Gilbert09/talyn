import { useMemo, useState } from 'react';
import { FolderGit2, Laptop, Loader2, Plus, Sparkles, X } from 'lucide-react';
import {
  CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES,
  codeReviewReviewersProblem,
  customReviewerSource,
  parseSkillKey,
  type CodeReviewCustomReviewer,
  type CodeReviewSettings,
  type ResolvedCodeReviewSettings,
  type SkillSummary,
} from '@talyn/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../ui/dialog';
import { Input } from '../../ui/input';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useSkills } from '../../../hooks/useSkills';
import { sortSkillsForPicker } from '../../../lib/skills';
import { cn } from '../../../lib/utils';

/**
 * Who reviews: Talyn's reviewers, the team's own, or both.
 *
 * A team's own reviewer is a skill. It runs as one more reviewer next to
 * Talyn's, and its findings go through the same second pass and the same check.
 * The source is the skill system and nothing else: a `SKILL.md` in a repository
 * of this workspace, or a skill saved to Talyn. There is no text box here, and a
 * skill on this machine cannot be chosen, because Talyn runs a review on its
 * servers and cannot read a file on a laptop.
 *
 * The two rules the server enforces are shown here first, from the same shared
 * function, so a control never offers something the save would refuse.
 */
export function ReviewersSettings({
  settings,
  disabled,
  onSave,
}: {
  settings: ResolvedCodeReviewSettings;
  disabled: boolean;
  onSave: (patch: CodeReviewSettings, what: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const reviewers = settings.customReviewers;

  // What each change would leave behind, asked of the rule the route applies.
  const offProblem = settings.builtInReviewers
    ? codeReviewReviewersProblem({ builtInReviewers: false, customReviewers: reviewers })
    : null;
  const removeLastProblem =
    reviewers.length === 1
      ? codeReviewReviewersProblem({
          builtInReviewers: settings.builtInReviewers,
          customReviewers: [],
        })
      : null;

  const remove = (skillKey: string) =>
    onSave(
      { customReviewers: reviewers.filter((r) => r.skillKey !== skillKey) },
      'your reviewers'
    );

  return (
    <div className="space-y-3">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={settings.builtInReviewers}
          disabled={disabled || offProblem !== null}
          onChange={(e) => {
            // The rule again, not only the disabled attribute: this must not
            // send a save the server is known to refuse.
            if (!e.target.checked && offProblem) return;
            onSave({ builtInReviewers: e.target.checked }, "Talyn's reviewers");
          }}
          className="mt-1"
          data-attr="settings-code-review-builtin-reviewers"
          aria-label="Talyn's reviewers"
        />
        <div className="flex-1">
          <div className="text-sm font-medium">Talyn&rsquo;s reviewers</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Logic, Security, Reliability and the others for the depth you choose.
          </p>
          {offProblem && (
            <p className="mt-1 text-xs text-muted-foreground" data-attr="reviewers-off-hint">
              To turn these off, add a reviewer of your own first.
            </p>
          )}
        </div>
      </label>

      <div className="border-t pt-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">Your reviewers</p>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setPicking(true)}
            data-attr="settings-code-review-add-reviewer"
            className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            <Plus className="h-3 w-3" />
            Add reviewer
          </button>
        </div>

        {reviewers.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            None yet. Add a skill from a repository or from Talyn, and it reads every review
            as one more reviewer.
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {reviewers.map((reviewer) => {
              const repo = parseSkillKey(reviewer.skillKey)?.source === 'repo';
              const source = customReviewerSource(reviewer.skillKey);
              return (
                <li
                  key={reviewer.skillKey}
                  className="flex items-start gap-2 rounded-md border px-2.5 py-1.5"
                  data-attr="settings-code-review-reviewer"
                >
                  {repo ? (
                    <FolderGit2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{reviewer.name}</p>
                    <p className="truncate text-[11px] text-muted-foreground">{source}</p>
                    {repo && (
                      <p className="text-[11px] text-muted-foreground">
                        Runs on pull requests in {source} only.
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={disabled || removeLastProblem !== null}
                    onClick={() => remove(reviewer.skillKey)}
                    aria-label={`Remove ${reviewer.name}`}
                    title={removeLastProblem ?? `Remove ${reviewer.name}`}
                    className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {removeLastProblem && (
          <p className="mt-2 text-xs text-muted-foreground" role="note" data-attr="reviewers-last-hint">
            This is your only reviewer. Turn on Talyn&rsquo;s reviewers before you remove it.
          </p>
        )}

        <p className="mt-2 text-[11px] text-muted-foreground">
          Each reviewer is one agent run per review. A large pull request costs more, because
          Talyn splits it into parts and each reviewer reads each part.
        </p>
      </div>

      <ReviewerSkillPicker
        open={picking}
        added={reviewers}
        onClose={() => setPicking(false)}
        onPick={(picked) => {
          setPicking(false);
          onSave({ customReviewers: [...reviewers, picked] }, 'your reviewers');
        }}
      />
    </div>
  );
}

/** Why a skill cannot be chosen as a reviewer, or null when it can. */
export function reviewerSkillRefusal(
  skill: SkillSummary,
  added: readonly CodeReviewCustomReviewer[]
): string | null {
  if (skill.source === 'local') {
    return 'On this machine only. Talyn runs reviews on its servers.';
  }
  if (added.some((r) => r.skillKey === skill.key)) return 'Already a reviewer';
  if ((skill.contentSize ?? 0) > CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES) {
    return 'Too large to run as a reviewer';
  }
  return null;
}

/**
 * Choose a skill to review with.
 *
 * The same skills data the "run a skill" picker reads, through the same hook
 * and cache. It is its own dialog because that picker is bound to one pull
 * request and launches a task, and this one chooses for a whole workspace: so
 * it has a repository selector, and a skill it cannot use is shown with the
 * reason instead of being offered.
 */
function ReviewerSkillPicker({
  open,
  added,
  onClose,
  onPick,
}: {
  open: boolean;
  added: readonly CodeReviewCustomReviewer[];
  onClose: () => void;
  onPick: (reviewer: CodeReviewCustomReviewer) => void;
}) {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const repositories = useWorkspaceStore((s) => s.repositories);
  const workspaceRepos = useMemo(
    () => repositories.filter((r) => r.workspaceId === currentWorkspaceId),
    [repositories, currentWorkspaceId]
  );
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const repoId = selectedRepoId ?? workspaceRepos[0]?.id ?? null;
  const repoName = workspaceRepos.find((r) => r.id === repoId)?.fullName ?? null;
  const { skills, usage, repoStatus, repoError, loading } = useSkills(
    open ? currentWorkspaceId : null,
    open ? repoId : null
  );
  const [query, setQuery] = useState('');

  const sorted = useMemo(() => sortSkillsForPicker(skills, usage, query), [skills, usage, query]);
  const groups = [
    {
      title: repoName ? `In ${repoName}` : 'In the repository',
      icon: FolderGit2,
      items: sorted.filter((s) => s.source === 'repo'),
    },
    { title: 'On Talyn', icon: Sparkles, items: sorted.filter((s) => s.source === 'platform') },
    { title: 'On this machine', icon: Laptop, items: sorted.filter((s) => s.source === 'local') },
  ].filter((g) => g.items.length > 0);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl p-4" onClose={onClose}>
        <DialogHeader className="mb-2">
          <DialogTitle className="text-base">Add a reviewer</DialogTitle>
        </DialogHeader>

        <div className="mb-2 flex items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills…"
            className="h-8"
            data-attr="reviewer-picker-search"
          />
          {workspaceRepos.length > 1 && (
            <select
              value={repoId ?? ''}
              onChange={(e) => setSelectedRepoId(e.target.value || null)}
              aria-label="Repository"
              className="max-w-[220px] shrink-0 rounded-md border bg-background px-2 py-1 text-xs"
            >
              {workspaceRepos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.fullName}
                </option>
              ))}
            </select>
          )}
        </div>

        {repoStatus === 'error' && (
          <p className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
            Could not load this repository&rsquo;s skills{repoError ? `: ${repoError}` : ''}.
          </p>
        )}

        <div className="max-h-[24rem] overflow-y-auto">
          {loading && groups.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading skills…
            </div>
          ) : groups.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {query.trim()
                ? 'No skills match your search.'
                : 'No skills found. Commit one under .claude/skills in the repository, or add one in Settings, Skills.'}
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.title} className="mb-1">
                <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {group.title}
                </div>
                {group.items.map((skill) => {
                  const refusal = reviewerSkillRefusal(skill, added);
                  return (
                    <button
                      key={skill.key}
                      type="button"
                      disabled={refusal !== null}
                      onClick={() => onPick({ skillKey: skill.key, name: skill.name })}
                      data-attr="reviewer-picker-skill"
                      className={cn(
                        'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/60',
                        refusal && 'cursor-not-allowed opacity-50 hover:bg-transparent'
                      )}
                    >
                      <group.icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{skill.name}</span>
                        {(refusal || skill.description) && (
                          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                            {refusal ?? skill.description}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
