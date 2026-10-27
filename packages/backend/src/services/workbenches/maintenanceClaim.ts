import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getPoolDbClient } from '../../db/client.js';

function rows(result: unknown): unknown[] {
  return Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
}

/** Renew before each side effect. A stalled worker cannot use an expired claim. */
export async function withMaintenanceClaim(name: string, run: (renew: () => Promise<void>) => Promise<void>): Promise<boolean> {
  const db = getPoolDbClient();
  const token = randomUUID();
  const claimed = await db.execute(sql`INSERT INTO workbench_maintenance_claims (name, token, expires_at)
    VALUES (${name}, ${token}, now() + interval '2 minutes')
    ON CONFLICT (name) DO UPDATE SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
    WHERE workbench_maintenance_claims.expires_at < now() RETURNING name`);
  if (rows(claimed).length === 0) return false;
  const renew = async () => {
    const result = await db.execute(sql`UPDATE workbench_maintenance_claims SET expires_at = now() + interval '2 minutes'
      WHERE name = ${name} AND token = ${token} AND expires_at > now() RETURNING name`);
    if (rows(result).length === 0) throw new Error(`The ${name} claim expired.`);
  };
  try {
    await run(renew);
    return true;
  } finally {
    await db.execute(sql`DELETE FROM workbench_maintenance_claims WHERE name = ${name} AND token = ${token}`);
  }
}
