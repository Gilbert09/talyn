import * as React from 'react';
import { Bot, BarChart3, Cloud } from 'lucide-react';
import { readCloudTaskProvider, type CloudProviderType } from '@fastowl/shared';
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
 * Which cloud provider a task runs on. The task's **assigned environment** is
 * authoritative — its `type` is set at creation and is how the queue routes
 * dispatch, so it reflects where the run actually happens and never gets lost.
 * Task metadata (`cloudTask.provider`) is only a fallback for when the env isn't
 * in the store yet. (Earlier we read metadata first; partial WS updates from the
 * pollers can strip the provider marker, which mis-showed Claude runs as PostHog.)
 */
export function taskCloudProvider(
  task: { metadata?: Record<string, unknown> | null; assignedEnvironmentId?: string },
  environments: ReadonlyArray<{ id: string; type: string }>,
): CloudProviderType | null {
  const envType = environments.find((e) => e.id === task.assignedEnvironmentId)?.type;
  if (envType && envType in PROVIDER_META) return envType as CloudProviderType;
  return readCloudTaskProvider(task);
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
