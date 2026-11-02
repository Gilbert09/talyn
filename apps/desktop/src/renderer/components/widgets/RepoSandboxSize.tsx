import React, { useEffect, useState } from 'react';
import {
  SANDBOX_SIZES,
  formatPricePerHour,
  type RepositorySandboxSizeResponse,
  type SandboxSize,
  type SandboxSizeSetting,
  type SizePrice,
} from '@talyn/shared';
import { api } from '../../lib/api';
import { hasUsageBilling } from '../../lib/usageBilling';
import { useBillingStore } from '../../stores/billing';
import { toast } from '../../stores/toast';
import { Select } from '../ui/select';

/**
 * One size's option text. With usage billing it carries the price and the
 * weight, and a size the plan cannot start is marked Pro; without it (an
 * older backend) it is the label and hint, as before.
 */
export function sizeOptionLabel(size: SandboxSize, price: SizePrice | undefined): string {
  const config = SANDBOX_SIZES[size];
  if (!price) return `${config.label} — ${config.hint}`;
  if (!price.allowed) return `${config.label} (Pro)`;
  return `${config.label}: ${formatPricePerHour(price.priceMicrosPerHour)}, ${price.weight}x box-hours`;
}

/** The size of the sandbox a session on this repository gets. Hidden for an account without sessions. */
export function RepoSandboxSize({ repositoryId, hideLabel = false, onInfoChange }: { repositoryId: string; hideLabel?: boolean; onInfoChange?: (info: RepositorySandboxSizeResponse) => void }) {
  const [info, setInfo] = useState<RepositorySandboxSizeResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const status = useBillingStore((s) => s.status);
  const prices = hasUsageBilling(status) ? status.sizePrices : undefined;
  const priceOf = (size: SandboxSize) => prices?.find((p) => p.size === size);
  const locked = prices?.some((p) => !p.allowed) ?? false;

  useEffect(() => {
    let live = true;
    api.repositories.sandboxSize.get(repositoryId).then((next) => { if (live) { setInfo(next); onInfoChange?.(next); } }).catch(() => undefined);
    return () => { live = false; };
  }, [repositoryId]);

  if (!info) return null;

  const change = async (value: SandboxSizeSetting) => {
    setSaving(true);
    try {
      const next = await api.repositories.sandboxSize.set(repositoryId, value);
      setInfo(next);
      onInfoChange?.(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the sandbox size.');
    } finally {
      setSaving(false);
    }
  };

  const hint = info.setting === 'auto'
    ? `Auto picks ${SANDBOX_SIZES[info.effective].label}${info.detected ? `: ${info.detected.reason}` : '.'}`
    : info.detected?.reason ?? null;
  const effectiveLocked = priceOf(info.effective)?.allowed === false;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <label htmlFor={`sandbox-size-${repositoryId}`} className={hideLabel ? 'sr-only' : 'text-xs text-muted-foreground shrink-0'}>
          Sandbox size
        </label>
        <Select
          id={`sandbox-size-${repositoryId}`}
          className="h-8 text-xs"
          value={info.setting}
          disabled={saving}
          onChange={(e) => void change(e.target.value as SandboxSizeSetting)}
        >
          <option value="auto">Auto</option>
          {(Object.keys(SANDBOX_SIZES) as SandboxSize[]).map((size) => {
            const price = priceOf(size);
            // A locked size the repository already uses stays selectable, so
            // the select can still show what is set.
            const disabled = price?.allowed === false && info.setting !== size;
            return (
              <option key={size} value={size} disabled={disabled}>
                {sizeOptionLabel(size, price)}
              </option>
            );
          })}
        </Select>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {effectiveLocked && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {SANDBOX_SIZES[info.effective].label} boxes need Pro, so a new session here cannot start on your plan. Pick
          Standard, or{' '}
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() => useBillingStore.getState().setUpgradeModalOpen(true, 'size_requires_pro')}
          >
            upgrade to Pro
          </button>
          .
        </p>
      )}
      {locked && !effectiveLocked && (
        <p className="text-xs text-muted-foreground">Free runs small and standard boxes. Larger sizes need Pro.</p>
      )}
    </div>
  );
}
