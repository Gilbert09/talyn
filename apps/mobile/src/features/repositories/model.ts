import type { GitHubRepo, WatchedRepo } from '@talyn/client/native';
import {
  PLAN_LIMITS, SANDBOX_SIZES, formatPricePerHour, sizePriceTable,
  type PlanTier, type RepositorySandboxSizeResponse, type SandboxSize, type SandboxSizeSetting, type SizePrice,
} from '@talyn/shared';

/** The cache lifetime of the GitHub repository list, as on web. The list is costly to build. */
export const REPO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** A phone draws every result row at once in a scroll view, so the list stops here and asks for a search. */
export const REPO_LIST_CAP = 100;

export interface RepoMatches { shown: GitHubRepo[]; total: number; truncated: boolean }

/** Repositories that are not watched yet and match the search, sorted by name. */
export function matchRepos(all: readonly GitHubRepo[], watched: readonly Pick<WatchedRepo, 'fullName'>[], search: string,
  cap = REPO_LIST_CAP): RepoMatches {
  const taken = new Set(watched.map((repo) => repo.fullName.toLowerCase()));
  const query = search.trim().toLowerCase();
  const matched = all
    .filter((repo) => !taken.has(repo.full_name.toLowerCase()))
    .filter((repo) => !query || repo.full_name.toLowerCase().includes(query))
    .sort((a, b) => a.full_name.toLowerCase().localeCompare(b.full_name.toLowerCase()));
  return { shown: matched.slice(0, cap), total: matched.length, truncated: matched.length > cap };
}

/** Coarse "x ago" for the list's freshness line. */
export function formatAge(at: number, now = Date.now()): string {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** The short size name: "Standard" from "Standard · 4 GB". */
export const sizeName = (size: SandboxSize) => SANDBOX_SIZES[size].label.split(' · ')[0] ?? size;

export function settingLabel(setting: SandboxSizeSetting): string {
  return setting === 'auto' ? 'Auto' : SANDBOX_SIZES[setting].label;
}

/** "Auto: Standard · 4 GB" or "Large · 12 GB", for a repository row. */
export function sizeSummary(info: RepositorySandboxSizeResponse): string {
  return info.setting === 'auto' ? `Auto: ${SANDBOX_SIZES[info.effective].label}` : SANDBOX_SIZES[info.setting].label;
}

/** Web's hint under the picker: what auto picks and why, or why the detected size differs. */
export function sizeHint(info: RepositorySandboxSizeResponse): string | null {
  if (info.setting === 'auto') return `Auto picks ${SANDBOX_SIZES[info.effective].label}${info.detected ? `: ${info.detected.reason}` : '.'}`;
  return info.detected?.reason ?? null;
}

export interface SizeOption {
  setting: SandboxSizeSetting;
  label: string;
  detail: string;
  /** The plan cannot start this size. It stays visible, so a Free plan sees what Pro adds. */
  locked: boolean;
  selected: boolean;
}

/** The size's price line, like web's option text. */
export function priceText(price: SizePrice): string {
  return `${price.weight} box-hour${price.weight === 1 ? '' : 's'}/h · ${formatPricePerHour(price.priceMicrosPerHour)}`;
}

/**
 * The picker's rows. With no tier (billing is off on this server) nothing is
 * locked and no price is shown, as on web. A locked size that is already the
 * setting stays selectable, so the person can see it.
 */
export function sizeOptions(info: Pick<RepositorySandboxSizeResponse, 'setting'>, tier: PlanTier | null,
  prices: readonly SizePrice[] | null = tier ? sizePriceTable(tier) : null): SizeOption[] {
  const allowed = tier ? new Set<SandboxSize>(PLAN_LIMITS[tier].sizes) : null;
  const priceOf = new Map((prices ?? []).map((row) => [row.size, row]));
  const sizes = Object.keys(SANDBOX_SIZES) as SandboxSize[];
  return [
    { setting: 'auto', label: 'Auto', detail: 'Picks a size from the repository’s compose files.', locked: false, selected: info.setting === 'auto' },
    ...sizes.map((size) => {
      const price = priceOf.get(size);
      const locked = allowed ? !allowed.has(size) && info.setting !== size : false;
      const parts: string[] = [SANDBOX_SIZES[size].hint];
      if (price) parts.push(priceText(price));
      if (locked) parts.push('Requires Pro');
      return { setting: size, label: SANDBOX_SIZES[size].label, detail: parts.join(' · '), locked, selected: info.setting === size };
    }),
  ];
}

/** True when a new session here cannot start on the plan, like web's notice under the picker. */
export function effectiveLocked(info: Pick<RepositorySandboxSizeResponse, 'effective'>, tier: PlanTier | null): boolean {
  return tier ? !PLAN_LIMITS[tier].sizes.includes(info.effective) : false;
}
