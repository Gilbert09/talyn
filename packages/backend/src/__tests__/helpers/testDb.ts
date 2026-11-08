import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import * as schema from '../../db/schema.js';
import { setDbClient, resetDbClient, type Database } from '../../db/client.js';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, 'meta', '_journal.json');

function migrationsFingerprint(): string {
  const journalText = fs.readFileSync(JOURNAL_PATH, 'utf-8');
  const journal = JSON.parse(journalText) as { entries: { tag: string }[] };
  const hash = createHash('sha256').update(journalText);
  for (const { tag } of journal.entries) {
    const file = `${tag}.sql`;
    hash.update(file).update(fs.readFileSync(path.join(MIGRATIONS_DIR, file)));
  }
  return hash.digest('hex').slice(0, 16);
}

const TEMPLATE_PATH = path.join(os.tmpdir(), `talyn-test-db-${migrationsFingerprint()}`);
let templatePromise: Promise<void> | undefined;
let cleanupCount = 0;

async function initializeTestDb(pglite: PGlite): Promise<void> {
  // PGlite does not include the Supabase roles and auth schema.
  await pglite.exec(`CREATE SCHEMA IF NOT EXISTS auth`);
  await pglite.exec(`
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS text
    LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')
    $$;
  `);

  await pglite.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN NOINHERIT;
      END IF;
    END $$;
    CREATE ROLE anon NOLOGIN NOINHERIT;
    CREATE ROLE authenticator NOLOGIN NOINHERIT;
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
    GRANT anon, authenticated TO authenticator;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO PUBLIC, anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC, anon, authenticated;
    ALTER DEFAULT PRIVILEGES GRANT ALL ON SEQUENCES TO PUBLIC, anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO PUBLIC, anon, authenticated;
  `);

  const journal = JSON.parse(
    fs.readFileSync(JOURNAL_PATH, 'utf-8'),
  ) as { entries: { tag: string }[] };

  // Production uses this journal order and ignores unlisted SQL files.
  for (const { tag } of journal.entries) {
    const file = `${tag}.sql`;
    const full = path.join(MIGRATIONS_DIR, file);
    if (!fs.existsSync(full)) {
      throw new Error(
        `migration journal lists ${file} but it does not exist in ${MIGRATIONS_DIR}`,
      );
    }
    const statements = fs.readFileSync(full, 'utf-8')
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) await pglite.exec(statement);
  }
}

async function buildTestDbTemplate(): Promise<void> {
  if (fs.existsSync(TEMPLATE_PATH)) return;

  const temporaryPath = fs.mkdtempSync(`${TEMPLATE_PATH}.`);
  try {
    const pglite = new PGlite(pathToFileURL(temporaryPath).href, {
      relaxedDurability: true,
    });
    try {
      await initializeTestDb(pglite);
    } finally {
      await pglite.close();
    }

    try {
      fs.renameSync(temporaryPath, TEMPLATE_PATH);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
    }
  } finally {
    fs.rmSync(temporaryPath, { force: true, recursive: true });
  }
}

function testDbTemplate(): Promise<void> {
  templatePromise ??= buildTestDbTemplate();
  return templatePromise;
}

function terminateTestDb(pglite: PGlite): void {
  const mod = (
    pglite as unknown as {
      mod?: {
        _pgl_setPGliteActive: (active: number) => void;
        _emscripten_force_exit: (status: number) => void;
      };
    }
  ).mod;
  if (!mod) throw new Error('PGlite runtime is unavailable during test cleanup');

  mod._pgl_setPGliteActive(0);
  try {
    mod._emscripten_force_exit(0);
  } catch (error) {
    if ((error as { status?: number }).status !== 0) throw error;
  }
}

/**
 * Create an isolated database from the migrated template and register it as
 * the process-wide database client.
 *
 * Tests run with real Postgres semantics — jsonb, booleans, timestamp with
 * time zone — so row-conversion helpers and query logic are exercised
 * exactly as in production.
 */
export async function createTestDb(): Promise<{
  db: Database;
  pglite: PGlite;
  cleanup: () => Promise<void>;
}> {
  await testDbTemplate();
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'talyn-test-db-instance-'));
  let pglite: PGlite;
  try {
    fs.cpSync(TEMPLATE_PATH, dataPath, {
      recursive: true,
      mode: fs.constants.COPYFILE_FICLONE,
    });
    pglite = new PGlite(pathToFileURL(dataPath).href, {
      relaxedDurability: true,
    });
    await pglite.waitReady;
  } catch (error) {
    fs.rmSync(dataPath, { force: true, recursive: true });
    throw error;
  }
  const db = drizzlePglite(pglite, { schema, casing: 'snake_case' }) as unknown as Database;

  setDbClient(db);

  return {
    db,
    pglite,
    cleanup: async () => {
      resetDbClient();
      try {
        terminateTestDb(pglite);
      } finally {
        fs.rmSync(dataPath, { force: true, recursive: true });
      }
      cleanupCount += 1;
      if (cleanupCount % 10 === 0) globalThis.gc?.();
    },
  };
}

/**
 * Seed a user row. Tests that insert workspaces/environments must reference
 * an existing user since owner_id is NOT NULL. Defaults to a stable id so
 * tests can cross-reference without wiring the id through every helper.
 */
export async function seedUser(
  db: Database,
  overrides: Partial<{ id: string; email: string }> = {}
): Promise<{ id: string; email: string }> {
  const id = overrides.id ?? 'user-test';
  const email = overrides.email ?? `${id}@example.test`;
  await db.insert(schema.users).values({ id, email }).onConflictDoNothing();
  return { id, email };
}

/** Stable test user id — every fixture defaults to this unless overridden. */
export const TEST_USER_ID = 'user-test';
