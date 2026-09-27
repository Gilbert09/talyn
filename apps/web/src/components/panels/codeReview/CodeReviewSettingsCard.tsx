import { useState } from 'react';
import {
  CODE_REVIEW_PRESETS,
  CODE_REVIEW_PRESET_BLURBS,
  CODE_REVIEW_SEVERITY_LABELS,
  CODE_REVIEW_SEVERITY_ORDER,
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
import { Gauge, ScanSearch, ShieldCheck, Wrench } from 'lucide-react';
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
    <div className="space-y-3">
      <div>
        <h3 className="text-lg font-semibold">Code review</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Talyn reads a pull request and puts what it finds in the app.
        </p>
      </div>

      {/* A FLOW, not a list of switches. Each step is the question the previous
          answer raises: review everything → how hard → fix it for me → fix what.
          The two GitHub-posting settings sit apart at the end because they are a
          different decision — how loud Talyn is on somebody else's pull request —
          and mixing them into the flow made this page read as eight unrelated
          checkboxes. */}

      <Step
        n={1}
        icon={ScanSearch}
        title="Review every pull request"
        badge={settings.autoReview ? 'On' : 'Off'}
      >
        <Toggle
          checked={settings.autoReview}
          disabled={saving || !currentWorkspaceId}
          attr="settings-code-review-auto"
          title="Review my new pull requests automatically"
          onChange={(next) => void save({ autoReview: next }, 'automatic reviews')}
        >
          Every pull request you open in a watched repository is reviewed as you push. Part
          of Unlimited.
        </Toggle>
      </Step>

      <Step
        n={2}
        icon={Gauge}
        title="How deeply"
        badge={CODE_REVIEW_PRESET_LABELS[settings.preset]}
      >
        {/* Buttons rather than a dropdown, because a dropdown shows the blurb for
            whatever is already chosen — so comparing the three meant picking each
            in turn. The facts are derived from the preset plan and cannot promise
            a behaviour the engine will not perform. */}
        <div className="flex flex-wrap gap-1.5">
          {CODE_REVIEW_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              disabled={saving || !currentWorkspaceId}
              onClick={() => void save({ preset }, 'the review depth')}
              aria-pressed={settings.preset === preset}
              data-attr="settings-code-review-preset"
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-50',
                settings.preset === preset
                  ? 'border-primary bg-primary/10 font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {CODE_REVIEW_PRESET_LABELS[preset]}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {CODE_REVIEW_PRESET_BLURBS[settings.preset]}
        </p>
        <ul className="mt-1.5 space-y-0.5">
          {codeReviewPresetFacts(settings.preset).map((fact) => (
            <li key={fact} className="flex gap-1.5 text-xs text-muted-foreground">
              <span aria-hidden>·</span>
              <span>{fact}</span>
            </li>
          ))}
        </ul>
      </Step>

      <Step
        n={3}
        icon={Wrench}
        title="Fix findings for me"
        badge={settings.autoFix ? 'On' : 'Off'}
      >
        <Toggle
          checked={settings.autoFix}
          disabled={saving || !currentWorkspaceId}
          attr="settings-code-review-auto-fix"
          title="Fix findings without asking"
          onChange={(next) => void save({ autoFix: next }, 'automatic fixing')}
        >
          The only setting here that pushes a commit with nobody watching. It touches only
          findings that survived the checking pass and whose location was confirmed.
        </Toggle>
      </Step>

      {/* Step 4 exists only once step 3 is on: "which findings" is not a question
          until something is answering it. */}
      {settings.autoFix && (
        <Step
          n={4}
          icon={ShieldCheck}
          title="Which findings it may fix"
          badge={`${CODE_REVIEW_SEVERITY_LABELS[settings.autoFixSeverity]} and above`}
        >
          <div className="flex flex-wrap gap-1.5">
            {CODE_REVIEW_SEVERITY_ORDER.map((severity) => (
              <button
                key={severity}
                type="button"
                disabled={saving || !currentWorkspaceId}
                onClick={() =>
                  void save({ autoFixSeverity: severity }, 'what auto-fix may touch')
                }
                aria-pressed={settings.autoFixSeverity === severity}
                data-attr="settings-code-review-auto-fix-severity"
                className={cn(
                  'rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-50',
                  settings.autoFixSeverity === severity
                    ? 'border-primary bg-primary/10 font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {CODE_REVIEW_SEVERITY_LABELS[severity]}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Blockers only is the default. A review that raises six things is not usually six
            things worth a commit.
          </p>
        </Step>
      )}

      <Card className="space-y-4 p-4">
        <div>
          <h4 className="text-sm font-medium">On GitHub</h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Findings live in Talyn. These two are the exceptions.
          </p>
        </div>

        <Toggle
          checked={settings.fixSummaryComment}
          disabled={saving || !currentWorkspaceId}
          attr="settings-code-review-summary-comment"
          title="Post a summary comment after a fix"
          onChange={(next) => void save({ fixSummaryComment: next }, 'the summary comment')}
        >
          One short comment saying what was fixed and what was not, so the pull request&rsquo;s
          other readers know why the branch moved.
        </Toggle>

        <Toggle
          checked={settings.inlineComments}
          disabled={saving || !currentWorkspaceId}
          attr="settings-code-review-inline-comments"
          title="Post blockers as inline comments"
          onChange={(next) => void save({ inlineComments: next }, 'inline comments')}
        >
          The one setting that can make Talyn look like every other review bot. Only blockers
          are posted, and never for a review nobody asked for.
        </Toggle>
      </Card>
    </div>
  );
}

/**
 * One step of the flow.
 *
 * Numbered because the order is the point: each step is the question the
 * previous answer raises, and a reader who stops after step one has still made a
 * coherent choice.
 */
function Step({
  n,
  icon: Icon,
  title,
  badge,
  children,
}: {
  n: number;
  icon: typeof ScanSearch;
  title: string;
  badge: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
          {n}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <h4 className="text-sm font-medium">{title}</h4>
            <span className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {badge}
            </span>
          </div>
          <div className="mt-2">{children}</div>
        </div>
      </div>
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
