import { type RepositoryBake, validateRepositoryBake } from '@talyn/shared';
import { eq, sql } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { repositories } from '../../db/schema.js';

export async function getRepositoryBake(id: string): Promise<RepositoryBake | null | undefined> {
  const [row] = await getDbClient().select({ settings: repositories.settings })
    .from(repositories).where(eq(repositories.id, id)).limit(1);
  return row?.settings?.bake;
}

export async function putRepositoryBake(id: string, value: unknown): Promise<RepositoryBake> {
  const bake = validateRepositoryBake(value);
  await getDbClient().update(repositories).set({
    settings: sql`coalesce(${repositories.settings}, '{}'::jsonb) || ${JSON.stringify({ bake })}::jsonb`,
  }).where(eq(repositories.id, id));
  return bake;
}
