import { useState } from 'react';
import {
  CODE_REVIEW_PRESETS,
  CODE_REVIEW_PRESET_BLURBS,
  CODE_REVIEW_SEVERITY_LABELS,
  CODE_REVIEW_SEVERITY_ORDER,
  type CodeReviewSeverity,
  codeReviewPresetFacts,
  CODE_REVIEW_PRESET_LABELS,
  codeReviewOffered,
  resolveCodeReviewSettings,
  type CodeReviewSettings,
  type Workspace,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { useWorkspaceStore } from '../../../stores/workspace';
import { maybeHandleBillingLimit } from '../../../stores/billing';
import { trackEvent } from '../../../lib/analytics';
import { Card } from '../../ui/card';
import { cn } from '../../../lib/utils';
import { toast } from '../../../stores/toast';

/**
 * Code review's four settings.
 *
 * # Why this is a card in the Workspace section rather than its own nav entry
 *
 * These are decisions about how Talyn acts on this workspace's pull requests,
 * which is exactly what the Workspace section already collects — and the adjacency
 * is informative: "reply to human review comments" and "post inline comments for
 * blockers" are the same kind of decision about how loud Talyn is on GitHub, and
 * reading them together is how somebody forms a coherent posture. A tenth nav
 * entry for four controls is the bolted-on feeling this feature is avoiding.
 *
 * # Why all four are per-workspace
 *
 * Two of them are GitHub WRITES into repositories the workspace owns, and two
 * members must not be able to give one repository two comment policies. One spends
 * the owner's agent subscription and is plan-gated on the owner, so per-user would
 * be unenforceable. The depth preset is the arguable one, and it is a workspace
 * DEFAULT with a per-run override in the sheet's picker that is never stored —
 * mirroring how the fleet and PostHog model choices work.
 */
export function CodeReviewSettingsCard() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const features = useWorkspaceStore((s) => s.features);
  const [saving, setSaving] = useState(false);

  // Three-state, like every other gated surface: `null` features means still
  // loading and must draw nothing, because conflating that with "not offered" is
  // how a card flashes in and out on every launch.
  if (!codeReviewOffered(features)) return null;

  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const settings = resolveCodeReviewSettings(workspace?.settings?.codeReview);

  const save = async (patch: CodeReviewSettings, what: string) => {
    if (!currentWorkspaceId) return;
    setSaving(true);
    try {
      // Only the changed key is sent. The route deep-merges this object, so the
      // other three survive — a top-level jsonb merge would drop them.
      const next = { codeReview: patch } as Workspace['settings'];
      await api.workspaces.update(currentWorkspaceId, { settings: next });
      // After the write, so a refused change (the auto-review 402 below) is not
      // reported as one that happened. Every value here is an enum or a boolean
      // — the inline-comments opt-in rate is the number that says whether the
      // "findings stay in the app" posture is the right one.
      trackEvent('code_review_settings_changed', {
        keys: Object.keys(patch).join(','),
        ...patch,
      });
      setWorkspaces(
        workspaces.map((w) =>
          w.id === currentWorkspaceId
            ? {
                ...w,
                settings: {
                  ...w.settings,
                  codeReview: { ...w.settings?.codeReview, ...patch },
                } as Workspace['settings'],
              }
            : w
        )
      );
    } catch (err) {
      // Turning auto-review on without Unlimited is a 402 with its own code; the
      // billing store turns that into the FEATURE pitch rather than a red toast
      // quoting a limit nobody is at.
      if (maybeHandleBillingLimit(err, 'code_review_settings')) return;
      toast.error(`Could not change ${what}`, err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="space-y-4 p-4">
      <div>
        <h4 className="text-sm font-medium">Code review</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          Talyn reads a pull request and puts what it finds in the app. Nothing is posted on
          the pull request unless you ask for it below.
        </p>
      </div>

      {/* Three cards rather than a <select>.
          A dropdown shows the blurb for whatever is ALREADY chosen, so comparing
          the three meant selecting each in turn and reading what changed — the
          one thing somebody picking a depth actually needs to do. The facts are
          derived from CODE_REVIEW_PRESET_PLAN, so they cannot claim a behaviour
          the engine will not perform. */}
      <fieldset className="space-y-1.5" disabled={saving || !currentWorkspaceId}>
        <legend className="text-xs font-medium">How deeply to review</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {CODE_REVIEW_PRESETS.map((preset) => {
            const active = settings.preset === preset;
            return (
              <button
                key={preset}
                type="button"
                onClick={() => void save({ preset }, 'the review depth')}
                aria-pressed={active}
                data-attr="settings-code-review-preset"
                className={cn(
                  'rounded-md border p-2.5 text-left transition-colors disabled:opacity-50',
                  active
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'hover:border-muted-foreground/40'
                )}
              >
                <p className="text-xs font-medium">{CODE_REVIEW_PRESET_LABELS[preset]}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {CODE_REVIEW_PRESET_BLURBS[preset]}
                </p>
                <ul className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
                  {codeReviewPresetFacts(preset).map((fact) => (
                    <li key={fact} className="flex gap-1.5">
                      <span aria-hidden>·</span>
                      <span>{fact}</span>
                    </li>
                  ))}
                </ul>
              </button>
            );
          })}
        </div>
      </fieldset>

      <Toggle
        checked={settings.autoReview}
        disabled={saving || !currentWorkspaceId}
        attr="settings-code-review-auto"
        title="Review my new pull requests automatically"
        onChange={(next) => void save({ autoReview: next }, 'automatic review')}
      >
        Every pull request you open in a watched repository gets reviewed as soon as Talyn sees
        it, and again when you push. The findings stay in the app. Part of Unlimited.
      </Toggle>

      <Toggle
        checked={settings.fixSummaryComment}
        disabled={saving || !currentWorkspaceId}
        attr="settings-code-review-fix-comment"
        title="Post a summary comment after a fix"
        onChange={(next) => void save({ fixSummaryComment: next }, 'the fix summary comment')}
      >
        When Talyn fixes findings it pushes a commit to your branch. Turn this on and it also
        leaves one short comment saying what it fixed and what it did not, so the pull
        request&rsquo;s other readers know why the branch moved. Off by default — the commit
        already announces itself.
      </Toggle>

      <Toggle
        checked={settings.inlineComments}
        disabled={saving || !currentWorkspaceId}
        attr="settings-code-review-inline-comments"
        title="Post blockers as inline comments on the pull request"
        onChange={(next) => void save({ inlineComments: next }, 'inline comments')}
      >
        Off by default, and it is the one setting here that can make Talyn look like every
        other review bot. When on, only BLOCKERS are posted — never the rest, and never for a
        review nobody asked for. Leave it off if your reviewers live in Talyn.
      </Toggle>

      <Toggle
        checked={settings.autoFix}
        disabled={saving || !currentWorkspaceId}
        attr="settings-code-review-auto-fix"
        title="Fix findings without asking"
        onChange={(next) => void save({ autoFix: next }, 'automatic fixing')}
      >
        Off by default, and the only setting here that pushes a commit to your branch with
        nobody watching. It only touches findings that survived the checking pass and whose
        location was confirmed, so speculation and misplaced findings are left alone.
      </Toggle>

      {settings.autoFix && (
        <fieldset className="space-y-1.5 pl-1" disabled={saving || !currentWorkspaceId}>
          <legend className="text-xs font-medium">What it is allowed to fix</legend>
          <select
            value={settings.autoFixSeverity}
            onChange={(e) =>
              void save(
                { autoFixSeverity: e.target.value as CodeReviewSeverity },
                'what auto-fix may touch'
              )
            }
            className="h-8 w-full rounded-md border border-input bg-background bg-none px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 sm:w-64"
            data-attr="settings-code-review-auto-fix-severity"
          >
            {CODE_REVIEW_SEVERITY_ORDER.map((severity) => (
              <option key={severity} value={severity}>
                {CODE_REVIEW_SEVERITY_LABELS[severity]} and above
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Blockers only is the default. Widening this means Talyn commits for smaller
            findings too, and a review that raises six things is not usually six things worth
            a commit.
          </p>
        </fieldset>
      )}
    </Card>
  );
}

function Toggle({
  checked,
  disabled,
  title,
  attr,
  onChange,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  title: string;
  attr: string;
  onChange: (next: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1"
        data-attr={attr}
      />
      <div className="flex-1">
        <div className="text-sm font-medium">{title}</div>
        <p className="mt-1 text-xs text-muted-foreground">{children}</p>
      </div>
    </label>
  );
}
