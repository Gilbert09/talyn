import { useEffect, useState } from 'react';
import {
  CODE_REVIEW_PRESETS,
  CODE_REVIEW_PRESET_BLURBS,
  CODE_REVIEW_SEVERITY_LABELS,
  CODE_REVIEW_SEVERITY_ORDER,
  codeReviewLensLabel,
  codeReviewLensNames,
  codeReviewPresetFacts,
  type CodeReviewLensStat,
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
import { Filter, Gauge, ScanSearch, ShieldCheck, Users, Wrench } from 'lucide-react';
import { Card } from '../../ui/card';
import { cn } from '../../../lib/utils';
import { toast } from '../../../stores/toast';
import { ReviewersSettings } from './ReviewersSettings';

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
  // Fetched once when the page opens, not polled: it answers "is this reviewer
  // worth its cost", which is a question you ask occasionally.
  const [lensStats, setLensStats] = useState<CodeReviewLensStat[]>([]);
  useEffect(() => {
    if (!currentWorkspaceId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.codeReviews.lenses(currentWorkspaceId);
        if (!cancelled) setLensStats(res.lenses);
      } catch {
        // Silent: this is context, not a control. A settings page that cannot
        // show a statistic must still let somebody change a setting.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentWorkspaceId]);

  // Three-state, like every other gated surface: `null` features means still
  // loading and must draw nothing, because conflating that with "not offered" is
  // how a card flashes in and out on every launch.
  if (!codeReviewOffered(features)) return null;

  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const settings = resolveCodeReviewSettings(workspace?.settings?.codeReview);

  // Names for the lens keys of this workspace's own reviewers, for the history
  // below. A reviewer removed since then falls back to what its key says.
  const lensNames = codeReviewLensNames(settings.customReviewers);

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
      // The reviewer list goes as a COUNT. Its entries name repositories and
      // skills, which are not ours to send.
      const { customReviewers, ...values } = patch;
      trackEvent('code_review_settings_changed', {
        keys: Object.keys(patch).join(','),
        ...values,
        ...(customReviewers ? { custom_reviewers: customReviewers.length } : {}),
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
          answer raises: review everything → how hard → who reviews → what to show →
          fix it for me → fix what.
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

        {/* What each reviewer has actually been worth here, rather than what the
            preset promises. A lens that raises forty and keeps two is not
            thorough, it is expensive — and until this existed there was no way
            to tell those apart from inside the product. Shown only once there is
            history: "0 of 0" teaches nobody anything. */}
        {lensStats.length > 0 && (
          <div className="mt-3 space-y-1 border-t pt-3">
            <p className="text-xs font-medium">How each reviewer has done here</p>
            <p className="text-[11px] text-muted-foreground">
              Findings raised, and how many survived the checking pass.
            </p>
            <ul className="mt-1.5 space-y-1">
              {lensStats.map((stat) => (
                <li key={stat.lens} className="flex items-center gap-2 text-xs">
                  <span className="w-28 shrink-0 text-muted-foreground">
                    {codeReviewLensLabel(stat.lens, lensNames)}
                  </span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-primary"
                      style={{
                        width: `${stat.raised ? Math.round((stat.kept / stat.raised) * 100) : 0}%`,
                      }}
                    />
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {stat.kept} of {stat.raised} kept
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Step>

      <Step
        n={3}
        icon={Users}
        title="Who reviews"
        badge={reviewersBadge(settings.builtInReviewers, settings.customReviewers.length)}
      >
        <ReviewersSettings
          settings={settings}
          disabled={saving || !currentWorkspaceId}
          onSave={(patch, what) => void save(patch, what)}
        />
      </Step>

      <Step
        n={4}
        icon={Filter}
        title="What is worth your attention"
        badge={`${CODE_REVIEW_SEVERITY_LABELS[settings.reportingBar]} and above`}
      >
        {/* A DISPLAY bar, and deliberately not the same control as step 6's
            commit bar. Seeing a minor finding and having Talyn push a commit for
            one unattended are different risks, and one knob for both forces the
            cautious answer on the reader. */}
        <div className="flex flex-wrap gap-1.5">
          {CODE_REVIEW_SEVERITY_ORDER.map((severity) => (
            <button
              key={severity}
              type="button"
              disabled={saving || !currentWorkspaceId}
              onClick={() => void save({ reportingBar: severity }, 'what the list shows')}
              aria-pressed={settings.reportingBar === severity}
              data-attr="settings-code-review-reporting-bar"
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-50',
                settings.reportingBar === severity
                  ? 'border-primary bg-primary/10 font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {CODE_REVIEW_SEVERITY_LABELS[severity]}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          The further right, the fewer findings reach the list and the more each one
          matters. Anything below the bar is still found and still readable at the foot
          of the list — it just does not count towards the badge.
        </p>
      </Step>

      <Step
        n={5}
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

      {/* Step 6 exists only once step 5 is on: "which findings" is not a question
          until something is answering it. */}
      {settings.autoFix && (
        <Step
          n={6}
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

/** The step's badge: whose reviewers read a pull request. */
export function reviewersBadge(builtIn: boolean, custom: number): string {
  if (!custom) return builtIn ? "Talyn's" : 'None';
  const own = `${custom} of your own`;
  return builtIn ? `Talyn's and ${own}` : own;
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
