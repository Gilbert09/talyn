import path from 'path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { getDbClient, isRealPostgres, withStallLimit, type Database } from './client.js';
import { withBlockingAdvisoryLock } from '../services/advisoryLock.js';

/**
 * Resolve the absolute path to the Drizzle migrations folder. It ships at
 * `src/db/migrations` in source; compiled output preserves that layout under
 * `dist/db/migrations`. __dirname works for both `tsx` (dev) and `node` (prod).
 */
const MIGRATIONS_FOLDER = path.resolve(__dirname, 'migrations');

/**
 * Initialize the database: connect, run pending migrations, return the
 * Drizzle client. Every service/route consumes this return value.
 *
 * Migrations run under a blocking advisory lock so overlapping boots (every
 * Railway deploy runs old + new instances concurrently) queue instead of
 * racing DDL — the second boot waits, then finds nothing left to apply.
 *
 * Throws if `DATABASE_URL` is unset or migrations fail — both are fatal
 * for boot so callers shouldn't try to recover.
 *
 * The stall breaker is off here. A boot waits on purpose for the other
 * instance's migration run, and a DDL statement can be slow. A stall here
 * shows as a failed deploy, and the old instance keeps serving.
 */
export async function initDatabase(): Promise<Database> {
  const db = getDbClient();
  if (isRealPostgres()) {
    await withStallLimit(null, () =>
      withBlockingAdvisoryLock(db, 'db:migrate', () =>
        migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
      )
    );
  } else {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  }
  return db;
}

export type { Database } from './client.js';
