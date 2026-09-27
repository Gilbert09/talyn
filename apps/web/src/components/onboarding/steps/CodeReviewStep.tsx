import { useState } from 'react';
import { ScanSearch } from 'lucide-react';
import {
  CODE_REVIEW_PRESETS,
  CODE_REVIEW_PRESET_BLURBS,
  CODE_REVIEW_PRESET_LABELS,
  type CodeReviewPreset,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useBillingStore } from '../../../stores/billing';
import { cn } from '../../../lib/utils';

/**
 * The onboarding step that switches code review on.
 *
 * # Why the example is static
 *
 * `usePullRequestSync` is mounted in `MainLayout`, which is INSIDE the onboarding
 * gate — so at this point the app holds no pull requests and cannot show the
 * user their own. A hand-written example is the honest alternative to a spinner,
 * and it lets the one sentence that matters do its work: findings live here.
 *
 * # Why a free account is shown no checkbox
 *
 * Automatic review is part of Unlimited, and a 402 during onboarding is a
 * terrible first impression. So a free account reads a plain line about it
 * instead of being handed a control that refuses them.
 */
export function CodeReviewStep() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const status = useBillingStore((s) => s.status);
  const [preset, setPreset] = useState<CodeReviewPreset>('standard');
  const [auto, setAuto] = useState(false);
  const [saving, setSaving] = useState(false);

  // `plan !== 'free'` rather than `plan === 'unlimited'`: with billing switched
  // off entirely (local dev, self-hosted) the snapshot reports unlimited, and a
  // strict equality check would hide the control from the people developing it.
  const paid = status != null && status.plan !== 'free';

  const persist = async (next: { preset?: CodeReviewPreset; autoReview?: boolean }) => {
    if (!currentWorkspaceId) return;
    setSaving(true);
    try {
      await api.workspaces.update(currentWorkspaceId, {
        settings: { codeReview: next } as never,
      });
    } catch {
      // Silent. This is an optional step in a wizard somebody is trying to get
      // through; a red banner about a preference is out of proportion, and the
      // setting is a click away in Settings afterwards.
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-md border bg-muted/30 p-3">
        <ScanSearch className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-sm">
          Talyn can read your pull requests and tell you what is wrong with them.{' '}
          <span className="font-medium">Findings show up here, in Talyn.</span>
        </p>
      </div>

      {/* A static example rather than a screenshot: it stays honest when the UI
          changes, and it is the fastest way to show that this is a short list
          rather than a comment thread. */}
      <div className="space-y-1.5 rounded-md border p-3" aria-hidden>
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Blockers 1
        </p>
        <ExampleFinding
          dot="bg-red-500"
          title="getUser can return undefined"
          path="src/session.ts:41"
        />
        <p className="mt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Worth fixing 2
        </p>
        <ExampleFinding
          dot="bg-amber-500"
          title="This query runs once per row"
          path="src/dashboard.ts:112"
        />
        <ExampleFinding
          dot="bg-amber-500"
          title="The retry swallows the original error"
          path="src/client.ts:88"
        />
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium">How deeply should it look?</p>
        <div className="inline-flex rounded-md border p-0.5">
          {CODE_REVIEW_PRESETS.map((option) => (
            <button
              key={option}
              type="button"
              disabled={saving}
              onClick={() => {
                setPreset(option);
                void persist({ preset: option });
              }}
              className={cn(
                'rounded px-2.5 py-1 text-xs transition-colors',
                preset === option
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {CODE_REVIEW_PRESET_LABELS[option]}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{CODE_REVIEW_PRESET_BLURBS[preset]}</p>
      </div>

      {paid ? (
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={auto}
            disabled={saving}
            onChange={(e) => {
              setAuto(e.target.checked);
              void persist({ autoReview: e.target.checked });
            }}
            className="mt-0.5"
          />
          <span className="text-xs">
            Review my new pull requests automatically, so the findings are already there when I
            look.
          </span>
        </label>
      ) : (
        <p className="text-xs text-muted-foreground">
          Review any pull request with one click. Reviewing every new one automatically is part
          of Unlimited.
        </p>
      )}
    </div>
  );
}

function ExampleFinding({
  dot,
  title,
  path,
}: {
  dot: string;
  title: string;
  path: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
      <div className="min-w-0">
        <p className="truncate text-xs">{title}</p>
        <p className="truncate font-mono text-[10px] text-muted-foreground">{path}</p>
      </div>
    </div>
  );
}
