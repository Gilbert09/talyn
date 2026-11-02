import React, { useEffect, useMemo, useState } from 'react';
import {
  SANDBOX_SIZES,
  formatPricePerHour,
  sizePriceTable,
  type RepositorySandboxSizeResponse,
  type SandboxSize,
  type SandboxSizeSetting,
  type SizePrice,
} from '@talyn/shared';
import { api } from '../../lib/api';
import { toast } from '../../stores/toast';
import { maybeHandleBillingLimit, useBillingStore } from '../../stores/billing';
import { usageBillingOf } from '../../lib/usageBilling';
import { Select } from '../ui/select';

/**
 * One size's option text. With usage billing it carries the size's weight and
 * hourly price, and a size the plan cannot start says "Pro".
 */
export function sizeOptionLabel(size: SandboxSize, price: SizePrice | null): string {
  const config = SANDBOX_SIZES[size];
  const base = `${config.label} — ${config.hint}`;
  if (!price) return base;
  const weight = `${price.weight} box-hour${price.weight === 1 ? '' : 's'}/h`;
  return `${base} · ${weight} · ${formatPricePerHour(price.priceMicrosPerHour)}${price.allowed ? '' : ' · Pro'}`;
}

/** The size of the sandbox a session on this repository gets. Hidden for an account without sessions. */
export function RepoSandboxSize({ repositoryId, hideLabel = false, onInfoChange }: { repositoryId: string; hideLabel?: boolean; onInfoChange?: (info: RepositorySandboxSizeResponse) => void }) {
  const [info, setInfo] = useState<RepositorySandboxSizeResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const status = useBillingStore((s) => s.status);
  // Null on a backend without usage billing: the picker stays as it was.
  const prices = useMemo(() => {
    const view = usageBillingOf(status);
    if (!view) return null;
    const rows = view.status.sizePrices ?? sizePriceTable(view.tier);
    return new Map(rows.map((row) => [row.size, row]));
  }, [status]);

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
      if (!maybeHandleBillingLimit(err, 'sandbox_size')) {
        toast.error(err instanceof Error ? err.message : 'Could not save the sandbox size.');
      }
    } finally {
      setSaving(false);
    }
  };

  const hint = info.setting === 'auto'
    ? `Auto picks ${SANDBOX_SIZES[info.effective].label}${info.detected ? `: ${info.detected.reason}` : '.'}`
    : info.detected?.reason ?? null;
  const effectivePrice = prices?.get(info.effective) ?? null;
  const lockedEffective = effectivePrice && !effectivePrice.allowed;

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
            const price = prices?.get(size) ?? null;
            const locked = price ? !price.allowed : false;
            return (
              // A size the plan cannot start stays visible, so Free can see
              // what Pro adds, but cannot be picked.
              <option key={size} value={size} disabled={locked && info.setting !== size}>
                {sizeOptionLabel(size, price)}
              </option>
            );
          })}
        </Select>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {effectivePrice && (
        <p className="text-xs text-muted-foreground" data-attr="sandbox-size-price">
          {lockedEffective
            ? `${SANDBOX_SIZES[info.effective].label.split(' · ')[0]} boxes need Pro. On your plan a new session here cannot start until you pick Standard or Small.`
            : `${SANDBOX_SIZES[info.effective].label} uses ${effectivePrice.weight} box-hour${effectivePrice.weight === 1 ? '' : 's'} per running hour, then ${formatPricePerHour(effectivePrice.priceMicrosPerHour)} from credits.`}
        </p>
      )}
    </div>
  );
}
