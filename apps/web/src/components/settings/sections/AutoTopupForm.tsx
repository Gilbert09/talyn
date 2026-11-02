import { useEffect, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import {
  CREDIT_PACKS,
  CREDIT_PACK_IDS,
  MICROS_PER_DOLLAR,
  formatUsd,
  validateAutoTopupConfig,
  type AutoTopupConfig,
  type AutoTopupSettings,
  type CreditPackId,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { useBillingStore } from '../../../stores/billing';
import { toast } from '../../../stores/toast';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Select } from '../../ui/select';
import { formatLongDate } from '../../../lib/usageBilling';

/** Whole or decimal dollars as typed, to micro-dollars. Null when it is not an amount. */
export function dollarsToMicros(text: string): number | null {
  const trimmed = text.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 100) * (MICROS_PER_DOLLAR / 100);
}

function microsToDollarText(micros: number): string {
  return formatUsd(micros).replace(/^\$/, '').replace(/\.00$/, '').replace(/,/g, '');
}

interface Draft {
  enabled: boolean;
  trigger: string;
  pack: CreditPackId;
  limit: string;
}

function draftFrom(settings: AutoTopupConfig): Draft {
  return {
    enabled: settings.enabled,
    trigger: microsToDollarText(settings.triggerMicros),
    pack: settings.pack,
    limit: microsToDollarText(settings.monthlyLimitMicros),
  };
}

/** The draft as a config, or the problems with it as sentences a person can act on. */
export function configFromDraft(draft: Draft): { config: AutoTopupConfig } | { errors: string[] } {
  const triggerMicros = dollarsToMicros(draft.trigger);
  const monthlyLimitMicros = dollarsToMicros(draft.limit);
  const errors: string[] = [];
  if (triggerMicros === null) errors.push('Enter the trigger balance in dollars, for example 5.');
  if (monthlyLimitMicros === null) errors.push('Enter the monthly limit in dollars, for example 100.');
  if (errors.length) return { errors };
  const config: AutoTopupConfig = {
    enabled: draft.enabled,
    triggerMicros: triggerMicros!,
    pack: draft.pack,
    monthlyLimitMicros: monthlyLimitMicros!,
  };
  const problems = validateAutoTopupConfig(config);
  return problems.length ? { errors: problems } : { config };
}

/**
 * Auto top-up: below a balance, buy a pack with the saved card, up to a
 * monthly limit. A failed charge shows here with a "Buy credits" fix.
 */
export function AutoTopupForm({ settings }: { settings: AutoTopupSettings }) {
  const refresh = useBillingStore((s) => s.refresh);
  const openUpgrade = useBillingStore((s) => s.setUpgradeModalOpen);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(settings));
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // A save elsewhere (another tab, the WS push) replaces the stored values.
  useEffect(() => {
    setDraft(draftFrom(settings));
  }, [settings.enabled, settings.triggerMicros, settings.pack, settings.monthlyLimitMicros]);

  const save = async () => {
    const result = configFromDraft(draft);
    if ('errors' in result) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      await api.billing.autoTopup.update(result.config);
      await refresh();
      toast.success(result.config.enabled ? 'Auto top-up is on' : 'Auto top-up is off');
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'Could not save auto top-up.']);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3" data-attr="auto-topup-form">
      {settings.lastFailure && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1 space-y-2 text-sm">
            <p>
              The last automatic top-up failed
              {settings.lastFailureAt ? ` on ${formatLongDate(settings.lastFailureAt)}` : ''}: {settings.lastFailure}
            </p>
            <p className="text-muted-foreground">Buy credits now, or save these settings to try again.</p>
            <Button size="sm" variant="outline" onClick={() => openUpgrade(true, 'add_credits')}>
              Buy credits
            </Button>
          </div>
        </div>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          aria-label="Turn on auto top-up"
        />
        Buy credits automatically when the balance is low
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>When the balance is below ($)</span>
          <Input
            inputMode="decimal"
            value={draft.trigger}
            onChange={(e) => setDraft({ ...draft, trigger: e.target.value })}
            aria-label="Trigger balance in dollars"
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Buy</span>
          <Select
            value={draft.pack}
            onChange={(e) => setDraft({ ...draft, pack: e.target.value as CreditPackId })}
            aria-label="Top-up amount"
          >
            {CREDIT_PACK_IDS.map((id) => (
              <option key={id} value={id}>
                {formatUsd(CREDIT_PACKS[id].priceMicros, 0)}
                {CREDIT_PACKS[id].bonusPercent ? ` (+${CREDIT_PACKS[id].bonusPercent}% bonus)` : ''}
              </option>
            ))}
          </Select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>At most per month ($)</span>
          <Input
            inputMode="decimal"
            value={draft.limit}
            onChange={(e) => setDraft({ ...draft, limit: e.target.value })}
            aria-label="Monthly limit in dollars"
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Spent by auto top-up this month: {formatUsd(settings.monthSpentMicros)}.
      </p>
      {errors.length > 0 && (
        <ul className="space-y-1 text-sm text-destructive">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <Button size="sm" onClick={() => void save()} disabled={saving} className="gap-2">
        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
        Save auto top-up
      </Button>
    </div>
  );
}
