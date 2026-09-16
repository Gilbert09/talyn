import React from 'react';
import { cn } from '../../lib/utils';

/**
 * "Where did you find Talyn?" — one optional question on the last onboarding
 * step.
 *
 * This exists because click-level attribution is unfixable for the desktop
 * app, not because surveys are better than measurement. On the web the
 * marketing site and the app share a registrable domain, so posthog-js's
 * cross-subdomain cookie carries the anonymous distinct id (and with it the
 * referrer and every utm_*) into the account — see lib/analytics.ts. A
 * packaged Electron renderer has no such thread: the download happens in a
 * browser and the install runs in a different process with a different
 * storage, so nothing links the two. A self-reported answer is a worse
 * instrument than a UTM, and it is the only one available there.
 *
 * Deliberately optional and never gating Finish. This sits at the point where
 * the user is one click from their PR queue, and an acquisition metric is not
 * worth spending activation on.
 */

const SOURCES = [
  { id: 'hacker_news', label: 'Hacker News' },
  { id: 'x', label: 'X' },
  { id: 'reddit', label: 'Reddit' },
  { id: 'github', label: 'GitHub' },
  { id: 'search', label: 'Search' },
  { id: 'email', label: 'Email' },
  { id: 'friend', label: 'A friend' },
  { id: 'other', label: 'Somewhere else' },
] as const;

export type SignupSource = (typeof SOURCES)[number]['id'];

interface SourceSurveyProps {
  value: SignupSource | null;
  onSelect: (source: SignupSource) => void;
}

export function SourceSurvey({ value, onSelect }: SourceSurveyProps) {
  return (
    <div className="space-y-2 border-t pt-4">
      <p className="text-sm text-muted-foreground">
        Where did you find Talyn?
        <span className="ml-2 text-xs">Optional</span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        {SOURCES.map((source) => {
          const selected = value === source.id;
          return (
            <button
              key={source.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(source.id)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs transition-colors',
                selected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
              )}
            >
              {source.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
