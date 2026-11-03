import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { repositories, repositorySetupStepSessions, repositorySetupSteps, setupSteps, workspaces } from '../db/schema.js';
import {
  bakeWithLearnedSteps,
  boxLayerContextFrom,
  LEARNED_PATH_LINE,
  LEGACY_DOCKER_START_COMMAND,
  mergeLearnedSetup,
  resolveWorkbenchConfig,
  type AppliedSetupStep,
  type RepositoryBake,
} from '@talyn/shared';

const layers = await import('../services/workbenches/setupLayers.js');

const MIGRATION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/migrations/0106_setup_steps.sql');
const NOW = new Date();
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

/**
 * Migration 0106 moves the bake and the setup recipe into the Setup list. The
 * fixture is a repository with every state the old recipe had. The test
 * computes the OLD box set and image set by hand from the old rules, runs the
 * migration on the old rows, and checks that the new code gives the same box
 * script and the same bake, byte for byte.
 */
describe('migration 0106: the Setup list', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  async function runMigrationAgain() {
    const statements = fs.readFileSync(MIGRATION, 'utf-8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) await testDb.pglite.exec(stmt);
  }

  const learned = (id: string, values: Partial<typeof repositorySetupSteps.$inferInsert>) => ({
    id,
    repositoryId: 'repo-a',
    stepKey: `key-${id}`,
    command: `echo ${id}`,
    kind: 'other',
    phase: 'install',
    source: 'learned',
    sourceWorkbenchId: `wb-${id}`,
    firstSeenAt: ago(600),
    lastSeenAt: ago(60),
    seenCount: 3,
    sessionCount: 2,
    ...values,
  });

  const ownBake: RepositoryBake = {
    steps: [
      { name: 'Install protoc', run: 'sudo apt-get install -y protobuf-compiler', timeoutSec: 300 },
      { name: 'Warm the cache', run: 'make warm' },
    ],
    hosts: ['example.com'],
  };

  beforeEach(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await testDb.db.insert(workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A' });
    await testDb.db.insert(repositories).values([
      { id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app', settings: { bake: ownBake } },
      { id: 'repo-b', workspaceId: 'ws-a', name: 'acme/lib', url: 'https://github.com/acme/lib', settings: { bake: { steps: [] } } },
      { id: 'repo-c', workspaceId: 'ws-a', name: 'acme/none', url: 'https://github.com/acme/none' },
    ]);
    // The old rows, in learning order (ordinal). Kinds out of order on purpose.
    await testDb.db.insert(repositorySetupSteps).values([
      learned('st_compose', { kind: 'compose', phase: 'start', command: 'docker compose up -d', confirmedAt: ago(500) }),
      learned('st_cargo', { kind: 'cargo', command: 'cargo install sqlx-cli', confirmedAt: ago(500), appliedAt: ago(400) }),
      learned('st_waiting', { kind: 'pip', command: 'pip install ruff', sessionCount: 1 }),
      learned('st_reverted', { kind: 'node', command: 'npm i -g pnpm', confirmedAt: ago(500), disabledAt: ago(300), disabledReason: 'Reverted by a person.' }),
      learned('st_failing', { kind: 'uv', command: 'uv tool install x', confirmedAt: ago(500), boxDisabledAt: ago(200), boxDisabledReason: 'Failed on 2 boxes in a row.', boxFailureCount: 2, boxLastFailure: 'exit 1' }),
      learned('st_go', { kind: 'go', command: 'go install x@latest', confirmedAt: ago(500), appliedAt: ago(400), bakeDisabledAt: ago(100), bakeDisabledReason: 'exit 2' }),
      learned('st_apt', { kind: 'apt', command: 'sudo apt-get install -y jq', confirmedAt: ago(1), lastDurationMs: 1200, typicalDurationMs: 1100, measuredBoxes: 4 }),
      learned('st_docker', { kind: 'docker', phase: 'start', command: LEGACY_DOCKER_START_COMMAND, confirmedAt: ago(500) }),
      learned('st_b1', { repositoryId: 'repo-b', kind: 'cargo', command: 'cargo install just', confirmedAt: ago(500), appliedAt: ago(400) }),
    ]);
    // The old sessions table pointed at repository_setup_steps. Drop the new
    // key so the old rows go in, then the migration points it again.
    await testDb.pglite.exec('ALTER TABLE "repository_setup_step_sessions" DROP CONSTRAINT IF EXISTS "repository_setup_step_sessions_step_id_setup_steps_fk"');
    await testDb.db.insert(repositorySetupStepSessions).values([
      { stepId: 'st_cargo', workbenchId: 'wb-1' },
      { stepId: 'st_cargo', workbenchId: 'wb-2' },
      { stepId: 'st_apt', workbenchId: 'wb-1' },
      { stepId: 'st_gone', workbenchId: 'wb-1' },
    ]);
    await runMigrationAgain();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  /** The old box set: live (confirmed, not reverted, not failing), no old Docker start, in kind order. */
  const oldBoxSteps = (): AppliedSetupStep[] => [
    { id: 'st_apt', command: 'sudo apt-get install -y jq', kind: 'apt', phase: 'install', sourceWorkbenchId: 'wb-st_apt' },
    { id: 'st_cargo', command: 'cargo install sqlx-cli', kind: 'cargo', phase: 'install', sourceWorkbenchId: 'wb-st_cargo' },
    { id: 'st_go', command: 'go install x@latest', kind: 'go', phase: 'install', sourceWorkbenchId: 'wb-st_go' },
    { id: 'st_compose', command: 'docker compose up -d', kind: 'compose', phase: 'start', sourceWorkbenchId: 'wb-st_compose' },
  ];

  it('copies every row with its state, counters and ids, and keeps the sessions', async () => {
    const rows = await testDb.db.select().from(setupSteps).where(eq(setupSteps.repositoryId, 'repo-a')).orderBy(asc(setupSteps.position));
    expect(rows.map((r) => [r.id, r.origin, r.runOn, r.status])).toEqual([
      [expect.stringMatching(/^st_[0-9a-f]{20}$/), 'user', 'image', 'active'],
      [expect.stringMatching(/^st_[0-9a-f]{20}$/), 'user', 'image', 'active'],
      ['st_apt', 'learned', 'image', 'active'],
      ['st_cargo', 'learned', 'image', 'active'],
      ['st_go', 'learned', 'image', 'active'],
      ['st_waiting', 'learned', 'image', 'suggested'],
      ['st_failing', 'learned', 'image', 'disabled'],
      ['st_reverted', 'learned', 'image', 'dismissed'],
      ['st_docker', 'learned', 'box', 'active'],
      ['st_compose', 'learned', 'box', 'active'],
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(rows[0]).toMatchObject({ name: 'Install protoc', command: 'sudo apt-get install -y protobuf-compiler', timeoutSec: 300, acceptedBy: 'person' });
    expect(rows[1]).toMatchObject({ name: 'Warm the cache', command: 'make warm', timeoutSec: null });
    expect(byId.get('st_reverted')).toMatchObject({ statusReason: 'Reverted by a person.', acceptedBy: 'talyn' });
    expect(byId.get('st_failing')).toMatchObject({ statusReason: 'Failed on 2 boxes in a row.', boxFailureCount: 2, boxLastFailure: 'exit 1' });
    expect(byId.get('st_go')).toMatchObject({ imageFailureReason: 'exit 2' });
    expect(byId.get('st_go')!.imageFailedAt).not.toBeNull();
    expect(byId.get('st_apt')).toMatchObject({ lastDurationMs: 1200, typicalDurationMs: 1100, measuredBoxes: 4, imageAppliedAt: null, acceptedBy: 'talyn', stepKey: 'key-st_apt', seenCount: 3, sessionCount: 2 });
    expect(byId.get('st_waiting')).toMatchObject({ acceptedBy: null, confirmedAt: null });
    const [repo] = await testDb.db.select({ settings: repositories.settings }).from(repositories).where(eq(repositories.id, 'repo-a'));
    expect(repo.settings?.setupHosts).toEqual(['example.com']);
    // The old bake stays for the old route's one release.
    expect(repo.settings?.bake).toEqual(ownBake);
    const sessions = await testDb.db.select().from(repositorySetupStepSessions).orderBy(asc(repositorySetupStepSessions.stepId), asc(repositorySetupStepSessions.workbenchId));
    // A session row of a step that no longer exists goes; the others stay.
    expect(sessions.map((s) => `${s.stepId}/${s.workbenchId}`)).toEqual(['st_apt/wb-1', 'st_cargo/wb-1', 'st_cargo/wb-2']);
  });

  it('runs again without a change', async () => {
    const before = await testDb.db.select().from(setupSteps).orderBy(asc(setupSteps.id));
    await runMigrationAgain();
    const after = await testDb.db.select().from(setupSteps).orderBy(asc(setupSteps.id));
    expect(after.map((r) => [r.id, r.position, r.status])).toEqual(before.map((r) => [r.id, r.position, r.status]));
  });

  it('gives a new box the same setup script as before, on a host that reports no layers', async () => {
    const config = resolveWorkbenchConfig({ talynToml: '[scripts]\nsetup = "pnpm install"\n' });
    const image = await layers.imageSetupForCreate({ workspaceId: 'ws-a', repositoryId: 'repo-a', slug: 'acme/app', baseBranch: 'main', now: NOW });
    const ctx = boxLayerContextFrom({ goldenLayer: 'repo' }, image.legacyUserStepIds);
    const after = await layers.withBoxSetup({ repositoryId: 'repo-a', workspaceId: 'ws-a' }, config, ctx);
    const before = mergeLearnedSetup(config, oldBoxSteps());
    expect(after.setup?.command).toBe(before.setup?.command);
  });

  it('gives a box with no context file the same setup script as before', async () => {
    const config = resolveWorkbenchConfig({ talynToml: '[scripts]\nsetup = "pnpm install"\n' });
    // A box that an older Talyn created has no context file: the old rule.
    const after = await layers.withBoxSetup({ repositoryId: 'repo-a', workspaceId: 'ws-a' }, config, null);
    expect(after.setup?.command).toBe(mergeLearnedSetup(config, oldBoxSteps()).setup?.command);
  });

  it('sends the same legacy bake as before', async () => {
    const image = await layers.imageSetupForCreate({ workspaceId: 'ws-a', repositoryId: 'repo-a', slug: 'acme/app', baseBranch: 'main', now: NOW });
    // Old: own bake + live, applied, not bake-failed install steps (only cargo).
    const before = bakeWithLearnedSteps(ownBake, [
      { id: 'st_cargo', command: 'cargo install sqlx-cli', kind: 'cargo', phase: 'install', sourceWorkbenchId: 'wb-st_cargo' },
    ]);
    expect(image.bake).toEqual(before);
    expect(image.legacyUserStepIds).toHaveLength(2);
  });

  it('keeps an explicit empty bake explicit, and sends none for a repository that never had one', async () => {
    const b = await layers.imageSetupForCreate({ workspaceId: 'ws-a', repositoryId: 'repo-b', slug: 'acme/lib', baseBranch: 'main', now: NOW });
    expect(b.bake).toEqual(bakeWithLearnedSteps({ steps: [] }, [
      { id: 'st_b1', command: 'cargo install just', kind: 'cargo', phase: 'install' },
    ]));
    const c = await layers.imageSetupForCreate({ workspaceId: 'ws-a', repositoryId: 'repo-c', slug: 'acme/none', baseBranch: 'main', now: NOW });
    expect(c.bake).toBeNull();
    expect(c.layers).toEqual({ repo: { slug: 'acme/none', baseBranch: 'main' }, user: null });
  });

  it('puts the same steps into the user layer as into the old bake, in list order', async () => {
    const image = await layers.imageSetupForCreate({ workspaceId: 'ws-a', repositoryId: 'repo-a', slug: 'acme/app', baseBranch: 'main', now: NOW });
    expect(image.layers.repo).toEqual({ slug: 'acme/app', baseBranch: 'main' });
    expect(image.layers.user?.wide).toEqual({ steps: [] });
    expect(image.layers.user?.repo.steps).toEqual([
      { id: image.legacyUserStepIds[0], name: 'Install protoc', run: 'sudo apt-get install -y protobuf-compiler', timeoutSec: 300 },
      { id: image.legacyUserStepIds[1], name: 'Warm the cache', run: 'make warm', timeoutSec: 300 },
      { id: 'st_cargo', name: 'cargo install sqlx-cli', run: `${LEARNED_PATH_LINE}\ncargo install sqlx-cli`, timeoutSec: 900 },
    ]);
    expect(image.layers.user?.hosts).toEqual(['crates.io', 'example.com', 'index.crates.io', 'static.crates.io']);
  });

  it('on a host that reports layers, a box runs only what its image does not hold', async () => {
    const config = resolveWorkbenchConfig({ talynToml: '[scripts]\nsetup = "pnpm install"\n' });
    const image = await layers.imageSetupForCreate({ workspaceId: 'ws-a', repositoryId: 'repo-a', slug: 'acme/app', baseBranch: 'main', now: NOW });
    const ctx = boxLayerContextFrom({ layer: 'user', appliedStepIds: image.specStepIds, repoCommit: 'a'.repeat(40) }, image.legacyUserStepIds);
    const after = await layers.withBoxSetup({ repositoryId: 'repo-a', workspaceId: 'ws-a' }, config, ctx);
    const command = after.setup!.command;
    expect(command).not.toContain('cargo install sqlx-cli');
    expect(command).not.toContain('protobuf-compiler');
    // apt is not in the image yet (it waits for the list to settle), go failed there.
    expect(command).toContain('sudo apt-get install -y jq');
    expect(command).toContain('go install x@latest');
    expect(command).toContain('docker compose up -d');
    // A box on the repo layer only runs every image step itself, the person's too.
    const repoOnly = boxLayerContextFrom({ layer: 'repo', appliedStepIds: [] }, image.legacyUserStepIds);
    const onRepo = (await layers.withBoxSetup({ repositoryId: 'repo-a', workspaceId: 'ws-a' }, config, repoOnly)).setup!.command;
    expect(onRepo).toContain('protobuf-compiler');
    expect(onRepo).toContain('cargo install sqlx-cli');
  });
});
