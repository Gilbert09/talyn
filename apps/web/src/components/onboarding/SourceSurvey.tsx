import React from 'react';
import { cn } from '../../lib/utils';

/** Collect an optional signup source beside the first session form. */

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
