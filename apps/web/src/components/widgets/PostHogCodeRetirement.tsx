import { AlertTriangle } from 'lucide-react';
import {
  POSTHOG_CODE_RETIRED_NOTICE,
  posthogCodeConnectionExists,
  posthogCodeOffered,
  posthogCodeRetiringNotice,
} from '@talyn/shared';
import { useWorkspaceStore } from '../../stores/workspace';
import { cn } from '../../lib/utils';

/** Whether this workspace may see PostHog Code at all (the `posthogCodeRetired` flag). */
export function usePostHogCodeOffered(): boolean {
  const features = useWorkspaceStore((s) => s.features);
  const hasConnection = useWorkspaceStore((s) => posthogCodeConnectionExists(s.posthogStatus));
  return posthogCodeOffered(features, hasConnection);
}

/** Whether to tell this workspace that its PostHog Code connection is going away. */
export function usePostHogCodeRetiringNotice(): boolean {
  const features = useWorkspaceStore((s) => s.features);
  const hasConnection = useWorkspaceStore((s) => posthogCodeConnectionExists(s.posthogStatus));
  return posthogCodeRetiringNotice(features, hasConnection);
}

export function PostHogCodeRetiredNotice({ className }: { className?: string }) {
  return (
    <p
      data-attr="posthog-code-retired-notice"
      className={cn(
        'flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300',
        className
      )}
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{POSTHOG_CODE_RETIRED_NOTICE}</span>
    </p>
  );
}
