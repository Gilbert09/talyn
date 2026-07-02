import { eq } from 'drizzle-orm';
import { getDbClient, type Database } from '../db/client.js';
import { integrations as integrationsTable } from '../db/schema.js';
import { encryptString, isEncryptedEnvelope } from './tokenCrypto.js';

/**
 * One-time boot sweep: re-encrypt any legacy PLAINTEXT credentials still
 * sitting in `integrations.config` and null the plaintext fields.
 *
 * History: GitHub `config.accessToken` and PostHog `config.apiKey` were
 * originally stored in the clear; the encrypted envelopes
 * (`accessTokenEnc` / `apiKeyEnc`) came later, but old rows were only
 * migrated "on next write" — which for a healthy long-lived token is never.
 * This sweep finishes the job at boot, which is what allowed the plaintext
 * fallback read branches in github.ts / posthogCode/credentials.ts to be
 * DELETED: after one boot of this build, no plaintext remains to read.
 *
 * Per-row failures (e.g. an undecryptable half-written config) are logged
 * and skipped — a broken row already needed a reconnect, and it must not
 * block the boot or the other rows.
 */
export async function migrateLegacyPlaintextCredentials(
  db: Database = getDbClient()
): Promise<{ migrated: number; failed: number }> {
  let migrated = 0;
  let failed = 0;

  const rows = await db
    .select({
      id: integrationsTable.id,
      type: integrationsTable.type,
      config: integrationsTable.config,
    })
    .from(integrationsTable);

  for (const row of rows) {
    const config = (row.config as Record<string, unknown> | null) ?? {};
    const plaintextField =
      row.type === 'github' ? 'accessToken' : row.type === 'posthog' ? 'apiKey' : null;
    if (!plaintextField) continue;

    const plaintext = config[plaintextField];
    if (typeof plaintext !== 'string' || plaintext.length === 0) continue;

    const encField = row.type === 'github' ? 'accessTokenEnc' : 'apiKeyEnc';
    try {
      const next: Record<string, unknown> = { ...config };
      delete next[plaintextField];
      // If an envelope already exists (a later write encrypted a fresh
      // token but left the stale plaintext behind), keep it — it's newer.
      if (!isEncryptedEnvelope(next[encField])) {
        next[encField] = encryptString(plaintext);
      }
      await db
        .update(integrationsTable)
        .set({ config: next, updatedAt: new Date() })
        .where(eq(integrationsTable.id, row.id));
      migrated++;
    } catch (err) {
      failed++;
      console.error(
        `[credentialMigration] failed to re-encrypt ${row.type} integration ${row.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  if (migrated > 0 || failed > 0) {
    console.log(
      `[credentialMigration] re-encrypted ${migrated} legacy plaintext credential(s)` +
        (failed ? `, ${failed} failed (reconnect those integrations)` : '')
    );
  }
  return { migrated, failed };
}
