import * as React from 'react';
import { Bot, BarChart3, Cloud } from 'lucide-react';
import type { CloudProviderType } from '@fastowl/shared';
import { cn } from './utils';

// One canonical place mapping a cloud provider to its display name + icon, so
// the Tasks panel, task detail, PR-row task badge, and Settings all show the
// same thing. No brand SVGs yet — lucide glyphs with a brand-ish accent stand
// in (PostHog → chart, Claude → bot, Codex → cloud).

interface ProviderMeta {
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  /** Brand-ish accent colour for the icon. */
  className: string;
}

export const PROVIDER_META: Record<CloudProviderType, ProviderMeta> = {
  posthog_code: { label: 'PostHog Code', Icon: BarChart3, className: 'text-sky-500' },
  claude_code: { label: 'Claude Code', Icon: Bot, className: 'text-amber-500' },
  codex_cloud: { label: 'Codex Cloud', Icon: Cloud, className: 'text-emerald-500' },
};

/** Display name for a provider, or null when there's no resolved provider. */
export function providerLabel(provider: CloudProviderType | null | undefined): string | null {
  return provider ? PROVIDER_META[provider]?.label ?? null : null;
}

/**
 * The cloud provider's icon, brand-tinted, with a hover tooltip naming it.
 * Renders nothing for a task with no resolved provider (e.g. a queued task not
 * yet dispatched), so callers can drop it in unconditionally.
 */
export function ProviderIcon({
  provider,
  className,
  label,
}: {
  provider: CloudProviderType | null | undefined;
  className?: string;
  /** Override the tooltip; defaults to the provider's display name. */
  label?: string;
}) {
  if (!provider) return null;
  const meta = PROVIDER_META[provider];
  if (!meta) return null;
  const { Icon } = meta;
  return (
    <span
      title={label ?? meta.label}
      aria-label={label ?? meta.label}
      className="inline-flex shrink-0"
    >
      <Icon className={cn('h-3.5 w-3.5', meta.className, className)} />
    </span>
  );
}
