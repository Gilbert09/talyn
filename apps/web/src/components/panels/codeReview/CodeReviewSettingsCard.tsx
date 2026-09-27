import { useState } from 'react';
import {
  CODE_REVIEW_PRESETS,
  CODE_REVIEW_PRESET_BLURBS,
  CODE_REVIEW_PRESET_LABELS,
  codeReviewOffered,
  resolveCodeReviewSettings,
  type CodeReviewPreset,
  type CodeReviewSettings,
  type Workspace,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { useWorkspaceStore } from '../../../stores/workspace';
import { maybeHandleBillingLimit } from '../../../stores/billing';
import { trackEvent } from '../../../lib/analytics';
import { Card } from '../../ui/card';
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

      <div className="space-y-1.5">
        <label className="text-xs font-medium" htmlFor="code-review-depth">
          How deeply to review
        </label>
        <select
          id="code-review-depth"
          value={settings.preset}
          disabled={saving || !currentWorkspaceId}
          onChange={(e) =>
            void save({ preset: e.target.value as CodeReviewPreset }, 'the review depth')
          }
          className="h-8 w-full rounded-md border border-input bg-background bg-none px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
          data-attr="settings-code-review-preset"
        >
          {CODE_REVIEW_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {CODE_REVIEW_PRESET_LABELS[preset]}
            </option>
          ))}
        </select>
        {/* The blurb is what makes "no advanced panel" acceptable: a preset the
            user cannot see inside has to say what it does, or "Deep" is a mystery
            knob they will never pick on purpose. */}
        <p className="text-xs text-muted-foreground">
          {CODE_REVIEW_PRESET_BLURBS[settings.preset]}
        </p>
      </div>

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
