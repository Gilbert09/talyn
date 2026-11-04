import { getPoolDbClient } from '../../db/client.js';
import { workbenchBootSamples } from '../../db/schema.js';

/**
 * Box starts and wakes for Insights' speed section, mirrored from the
 * `boot_metric` events (docs/boot-metrics.md) into a small table. The event
 * stays the record; the row is what a page view reads. Keyed by the event's
 * (chat, seq), so the live write and the backfill store each sample once.
 */

export interface BootSample {
  kind: 'box_start' | 'wake';
  ms: number;
  cause: string | null;
  layer: string | null;
  source: string | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value.slice(0, 64) : null);

function ms(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/**
 * Pure: the sample a boot metric carries, or null. A box start needs its total
 * time; a wake must have worked and have a time. Other metrics carry none.
 */
export function bootSampleFromMetric(metric: unknown, fields: Record<string, unknown>): BootSample | null {
  if (metric === 'box_created') {
    const total = ms(fields.totalMs);
    if (total === null) return null;
    return { kind: 'box_start', ms: total, cause: text(fields.cause), layer: text(fields.layer), source: null };
  }
  if (metric === 'wake_end') {
    const took = ms(fields.ms);
    const ok = fields.ok === true || fields.ok === 'true';
    if (took === null || !ok) return null;
    return { kind: 'wake', ms: took, cause: null, layer: null, source: text(fields.from) };
  }
  return null;
}

export interface BootSampleRow extends BootSample {
  chatId: string;
  seq: number;
  workspaceId: string;
  workbenchId: string;
  at: Date;
}

export async function storeBootSamples(rows: readonly BootSampleRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const stored = await getPoolDbClient()
    .insert(workbenchBootSamples)
    .values([...rows])
    .onConflictDoNothing()
    .returning({ seq: workbenchBootSamples.seq });
  return stored.length;
}
