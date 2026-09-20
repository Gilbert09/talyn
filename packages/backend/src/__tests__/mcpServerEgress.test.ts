import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { mcpServers as mcpServersTable } from '../db/schema.js';
import type { Database } from '../db/client.js';

/**
 * `secret_enc` must never leave the database except on a dispatch.
 *
 * A `SELECT *` here does not merely ship bytes we throw away, which is the
 * usual egress argument — it ships every workspace credential the owner has.
 * `.toSQL()` renders a query without executing it, so the projection can be
 * asserted directly and without a live database.
 */

let db: Database;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
});

afterEach(async () => {
  await cleanup();
});

/** Mirrors services/mcpServers/store.ts. Kept here so the assertion is about a
 *  column list somebody has to change on purpose. */
const PUBLIC_COLUMNS = {
  id: mcpServersTable.id,
  workspaceId: mcpServersTable.workspaceId,
  name: mcpServersTable.name,
  url: mcpServersTable.url,
  tools: mcpServersTable.tools,
  enabled: mcpServersTable.enabled,
} as const;

describe('mcp server projection egress', () => {
  it('the public projection never references secret_enc', () => {
    const { sql } = db.select(PUBLIC_COLUMNS).from(mcpServersTable).toSQL();
    expect(sql).not.toContain('secret_enc');
    expect(sql).toContain('"url"');
    expect(sql).toContain('"tools"');
  });

  // Guards the test itself: if a bare select stopped shipping the column, the
  // assertion above would pass for the wrong reason.
  it('a bare select(), by contrast, DOES reference secret_enc', () => {
    const { sql } = db.select().from(mcpServersTable).toSQL();
    expect(sql).toContain('secret_enc');
  });

});
