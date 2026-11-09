import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { boxLayerContextFrom, type RepositorySettings, type SandboxSize } from '@talyn/shared';
import { getPoolDbClient, runWithoutScope } from '../../db/client.js';
import { mcpServers as mcpServersTable, repositories, workbenchWarmBoxes as boxes } from '../../db/schema.js';
import { isBoxGateError } from '../billing/entitlements.js';
import { debugBus } from '../debugBus.js';
import { hostIsDispatchable, listFleetHosts, type FleetHostView } from '../fleetHosts.js';
import { githubService } from '../github.js';
import { workspaceMayUseMcpServers } from '../mcpServersAccess.js';
import { FleetRunNotFoundError } from '../selfHosted/client.js';
import { sandboxPolicyForWorkspace } from '../selfHosted/privateRoutes.js';
import { resolveRepository } from '../selfHosted/sandboxRun.js';
import { recordSandboxAgents } from './credentialPolicy.js';
import { assertNewWorkbenchBox } from './boxGate.js';
import type { CreatedWorkbenchSandbox } from './lifecycle.js';
import { withMaintenanceClaim } from './maintenanceClaim.js';
import { isWorkbenchDraining } from './ownership.js';
import {
  cloneScript,
  fleetClientFor,
  gitAuthorFor,
  loadWorkbenchConfig,
  pushSessionCredentials,
  runCapture,
  sandboxIdFor,
  sandboxScriptEnv,
} from './sandboxRuntime.js';
import { sessionSandboxSize, sizeForSession } from './sandboxSize.js';
import { commandFor } from './scripts.js';
import { imageSetupForCreate } from './setupLayers.js';
import { recordBootMetric, type WorkbenchRow } from './store.js';
import { talynMcpServerFor } from './talynMcp.js';

/**
 * A warm pool of session boxes for a repository (boot plan R7).
 *
 * A new session normally waits for a box to boot (~2.5 s), the checkout
 * (~2-7 s) and the setup (~2 s on a user layer, minutes without one). The pool
 * does that work before anyone asks: each slot is a box created exactly like a
 * session's (`createWorkbenchSandbox`, so the same image stack and credential
 * rules), checked out at the default branch, detached, with the setup script
 * run. A session create for the repository takes one with a compare-and-set on
 * its row and continues as a normal provision on that box: the session's own
 * credentials go in, its branch is checked out from the fetched base, and its
 * setup runs, which is a no-op install when the lockfile has not changed.
 *
 * Configured per repository with `settings.warmPool` (a slot count). There is
 * no flag: a repository without the setting has no pool and pays nothing.
 *
 * Billing: a warm box opens NO usage interval. It is fleet overhead until a
 * claim, and the claimed session's interval opens at the claim, exactly as a
 * fresh box's opens at its boot. The rows stay after a box ends, so the
 * overhead (`created_at` to `claimed_at` or `ended_at`) can be counted.
 *
 * Credentials: a warm box holds what a session box of the same workspace holds
 * at create (the workspace's GitHub token, both usable agent keys and MCP secrets), with
 * one difference: the `talyn` MCP route carries a random secret that opens
 * nothing, because no session owns the box yet. The claim pushes the session's
 * whole set, which replaces it. Before a claim the fleet's credential pull for
 * the box is refused (no session row names it).
 *
 * The pool yields to real sessions: it does not fill while no host has a
 * quarter of its memory and run slots free, it drops a box whose host goes
 * below that, and a session that has to wait for room empties the pool at once
 * and keeps it empty for a cooldown.
 */

export const WARM_POOL_POLLER = 'workbench-warm-pool';

/** Fields, not constants, so tests can shorten them. */
export const WARM_POOL = {
  sweepMs: 60_000,
  /**
   * The fleet suspends a box after 10 idle minutes (`TALYN_SANDBOX_IDLE_TTL_SEC`,
   * every plan's ceiling), and an exec resets that clock. A suspended warm box
   * would wake in ~1-5 s and, after the tiered-storage window, move to the
   * bucket and wake in minutes. Every 4 minutes leaves two missed sweeps of slack.
   */
  keepAliveMs: 4 * 60_000,
  /** How often a ready box is compared with the current create inputs and the default branch. */
  checkMs: 10 * 60_000,
  /** Replaced at this age whatever the checks say: its fetch, its image and its credentials all age. */
  maxAgeMs: 4 * 60 * 60_000,
  /** After a real session had to wait for room, the pool stays empty this long. */
  yieldCooldownMs: 15 * 60_000,
  /** The share of a host's memory and run slots the pool leaves for real sessions. */
  hostReserveShare: 0.25,
  /** The checkout and the setup of a box with no layer: a large repository's cold install is minutes. */
  scriptTimeoutMs: 20 * 60_000,
};

/** Files whose change on the default branch makes a warm box's install stale. */
const DEPENDENCY_FILE = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|uv\.lock|poetry\.lock|Pipfile\.lock|requirements[^/]*\.txt|Gemfile\.lock|go\.sum|Cargo\.lock|composer\.lock|flake\.lock|\.tool-versions|\.nvmrc|\.node-version|\.python-version|conductor\.json)$|(?:^|\/)\.(?:talyn|conductor)\/settings\.toml$/;

/** GitHub's compare lists at most 300 files: a base that moved that far is a new box. */
const COMPARE_FILE_LIMIT = 300;

const BOOTED: ReadonlySet<string> = new Set(['idle', 'busy']);

export interface WarmPoolConfig {
  slots: number;
  agent: 'claude' | 'codex';
}

/** The repository's pool, or null when it has none. */
export function warmPoolConfig(settings: RepositorySettings | null | undefined): WarmPoolConfig | null {
  const raw = settings?.warmPool;
  const slots = typeof raw === 'number' ? raw : raw && typeof raw === 'object' ? raw.slots : 0;
  if (!Number.isInteger(slots) || slots < 1) return null;
  const agent = raw && typeof raw === 'object' && raw.agent === 'codex' ? 'codex' : 'claude';
  return { slots, agent };
}

/** A warm box's sandbox id: a session box's prefix, so the fleet treats it as one. 35 characters. */
export function warmSandboxId(id: string): string {
  return `talyn-wb-p-${id.replace(/-/g, '').slice(0, 24)}`;
}

const BOX_COLUMNS = {
  id: boxes.id,
  sandboxId: boxes.sandboxId,
  workspaceId: boxes.workspaceId,
  repositoryId: boxes.repositoryId,
  agent: boxes.agent,
  size: boxes.size,
  internetAccess: boxes.internetAccess,
  baseBranch: boxes.baseBranch,
  specHash: boxes.specHash,
  status: boxes.status,
  fleetHost: boxes.fleetHost,
  fleetSandboxId: boxes.fleetSandboxId,
  record: boxes.record,
  checkoutCommit: boxes.checkoutCommit,
  fillMs: boxes.fillMs,
  createdAt: boxes.createdAt,
  readyAt: boxes.readyAt,
  touchedAt: boxes.touchedAt,
  checkedAt: boxes.checkedAt,
  endReason: boxes.endReason,
} as const;
export type WarmBox = Pick<typeof boxes.$inferSelect, keyof typeof BOX_COLUMNS>;

const db = () => getPoolDbClient();

function note(action: string, summary: string, meta: Record<string, unknown>, ok = true, error?: unknown): void {
  console.log(`[warm-pool] ${summary}`);
  debugBus.recordEvent({
    service: 'workbenches',
    action,
    summary,
    ok,
    ...(typeof meta.workspaceId === 'string' ? { workspaceId: meta.workspaceId } : {}),
    meta,
    ...(error !== undefined ? { error } : {}),
  });
}

/**
 * The stand-in row a warm box's create, checkout and setup run against. It is
 * never written: no session owns the box, and the runtime helpers take a row.
 */
function boxRow(box: Pick<WarmBox, 'id' | 'workspaceId' | 'repositoryId' | 'agent' | 'size' | 'internetAccess' | 'baseBranch'>
  & { sandboxId: string; fleetHost: string | null }, slug: string): WorkbenchRow {
  const now = new Date();
  return {
    id: box.id, workspaceId: box.workspaceId, repositoryId: box.repositoryId, repoFullName: slug, kind: 'session',
    threadId: null, name: 'warm-pool', title: null, branch: box.baseBranch, baseBranch: box.baseBranch, runtime: 'sandbox',
    agent: box.agent, model: null, deviceId: null, localPath: null, sandboxId: box.sandboxId, sandboxGeneration: box.sandboxId,
    sandboxState: 'running', memoryRestorePending: null, archivePendingAt: null, archiveRetryAt: null, restoreRequestedAt: null,
    archiveLeaseUntil: null, archiveFailures: 0, fleetHost: box.fleetHost, status: 'provisioning', statusMessage: null, startProgress: null,
    pullRequestId: null, pullRequestLinkedAt: null, pushedHeadShas: [], allocatedBranch: false,
    settings: { internetAccess: box.internetAccess, sandboxSize: box.size as SandboxSize }, source: null, diffStat: null,
    workCheckpointSha: null, workCheckpointAt: null, workCheckpointBytes: null, workCheckedAt: null, workUnpushedCommits: null,
    workSaveFailures: 0, workSaveFailedAt: null, workSaveError: null, changesAt: null, changesEtag: null, spaceId: null, archivedAt: null,
    createdAt: now, updatedAt: now,
  };
}

// ============================================================================
// The spec: what a box of this repository is created with, secrets left out
// ============================================================================

interface WarmShape {
  workspaceId: string;
  repositoryId: string;
  slug: string;
  baseBranch: string;
  agent: string;
  size: SandboxSize;
  internetAccess: boolean;
}

/**
 * A hash of everything that decides what a box is created with, apart from
 * secrets: the image layers, the workspace's MCP servers, the commit author,
 * the agent, the size and the network. A ready box whose hash no longer
 * matches is replaced, so a changed Setup list or a new MCP server reaches the
 * next session that takes a box.
 */
export async function warmSpecHash(shape: WarmShape): Promise<string> {
  const image = await imageSetupForCreate({
    workspaceId: shape.workspaceId,
    repositoryId: shape.repositoryId,
    slug: shape.slug,
    baseBranch: shape.baseBranch,
  });
  const mcp = (await workspaceMayUseMcpServers(shape.workspaceId))
    ? await db()
      .select({ name: mcpServersTable.name, url: mcpServersTable.url, tools: mcpServersTable.tools, inject: mcpServersTable.inject })
      .from(mcpServersTable)
      .where(and(eq(mcpServersTable.workspaceId, shape.workspaceId), eq(mcpServersTable.enabled, true)))
      .orderBy(asc(mcpServersTable.name))
    : [];
  const author = (await gitAuthorFor(shape.workspaceId)) ?? null;
  const privateRoutes = (await sandboxPolicyForWorkspace(shape.workspaceId, {})).privateRoutes ?? [];
  return createHash('sha256')
    .update(JSON.stringify({
      v: 2,
      workspaceId: shape.workspaceId,
      repositoryId: shape.repositoryId,
      slug: shape.slug,
      baseBranch: shape.baseBranch,
      agent: shape.agent,
      size: shape.size,
      internetAccess: shape.internetAccess,
      layers: image.layers,
      bake: image.bake,
      mcp,
      author,
      privateRoutes,
    }))
    .digest('hex')
    .slice(0, 32);
}

// ============================================================================
// Host capacity
// ============================================================================

/** Whether the host keeps the pool's reserve free for real sessions. */
export function hostHasRoomForPool(host: FleetHostView, reserve = WARM_POOL.hostReserveShare): boolean {
  if (!hostIsDispatchable(host)) return false;
  if (host.memBudgetMib > 0 && host.memBudgetMib - host.memReservedMib < host.memBudgetMib * reserve) return false;
  if (host.runsMax > 0 && host.runsMax - host.runsLive < host.runsMax * reserve) return false;
  return true;
}

/** Whether the pool gave its boxes to a real session recently. */
async function yieldedRecently(): Promise<boolean> {
  const since = new Date(Date.now() - WARM_POOL.yieldCooldownMs);
  const [row] = await db()
    .select({ id: boxes.id })
    .from(boxes)
    .where(and(eq(boxes.endReason, 'yielded'), or(isNull(boxes.endedAt), gt(boxes.endedAt, since))))
    .limit(1);
  return Boolean(row);
}

// ============================================================================
// Ending a box
// ============================================================================

/**
 * End a box the pool still owns: a compare-and-set to `discarding` (so a
 * claim and a discard can never both win), then the fleet delete, then
 * `ended`. A failed delete leaves `discarding`, and the next sweep tries again.
 * False when the box was claimed or ended first.
 */
async function discardBox(box: WarmBox, reason: string): Promise<boolean> {
  const [taken] = await db()
    .update(boxes)
    .set({ status: 'discarding', endReason: reason })
    .where(and(eq(boxes.id, box.id), inArray(boxes.status, ['filling', 'ready'])))
    .returning(BOX_COLUMNS);
  if (!taken) return false;
  note('warm_pool_discard', `discarding ${box.sandboxId} of ${box.repositoryId}: ${reason}`, {
    workspaceId: box.workspaceId, repositoryId: box.repositoryId, sandboxId: box.sandboxId, reason,
  });
  await deleteDiscarded(taken);
  return true;
}

async function deleteDiscarded(box: WarmBox): Promise<void> {
  try {
    const client = await fleetClientFor(box.workspaceId, box.fleetHost);
    await client.deleteSandbox(box.sandboxId);
  } catch (error) {
    note('warm_pool_delete_failed', `deleting ${box.sandboxId} failed; the next sweep tries again`, {
      workspaceId: box.workspaceId, sandboxId: box.sandboxId,
    }, false, error);
    return;
  }
  await db().update(boxes).set({ status: 'ended', endedAt: new Date() })
    .where(and(eq(boxes.id, box.id), eq(boxes.status, 'discarding')));
}

/**
 * A real session is waiting for room: give every box the pool holds back to
 * the fleet, and keep the pool empty for the cooldown. Never throws.
 */
export async function yieldWarmPool(why: string): Promise<number> {
  try {
    const live = await db().select(BOX_COLUMNS).from(boxes)
      .where(and(isNull(boxes.endedAt), inArray(boxes.status, ['filling', 'ready'])));
    let freed = 0;
    for (const box of live) if (await discardBox(box, 'yielded')) freed++;
    if (freed > 0) note('warm_pool_yield', `gave ${freed} warm box(es) back to the fleet: ${why}`, { freed, why });
    return freed;
  } catch (error) {
    note('warm_pool_yield_failed', 'could not empty the warm pool for a waiting session', { why }, false, error);
    return 0;
  }
}

// ============================================================================
// The claim
// ============================================================================

export interface WarmClaim {
  created: Extract<CreatedWorkbenchSandbox, { ok: true }>;
  box: WarmBox;
  /** How long the box took to fill: the start the claim saves, before the session's own work. */
  fillMs: number | null;
}

async function repositoryPool(repositoryId: string): Promise<WarmPoolConfig | null> {
  const [repo] = await db().select({ settings: repositories.settings }).from(repositories)
    .where(eq(repositories.id, repositoryId)).limit(1);
  return warmPoolConfig(repo?.settings);
}

/**
 * Take a ready warm box for a NEW session's first box, or null for the normal
 * create. Never throws: any failure here is a miss, and the normal path runs.
 *
 * Multi-replica safe without a lock: two sessions can read the same candidate,
 * and the `ready -> claimed` update lets exactly one of them have it.
 */
export async function claimWarmBox(row: WorkbenchRow): Promise<WarmClaim | null> {
  if (row.kind === 'thread' || row.runtime !== 'sandbox' || !row.repositoryId || row.memoryRestorePending
    || row.sandboxState !== 'creating' || row.sandboxId !== sandboxIdFor(row.id)) return null;
  const repositoryId = row.repositoryId;
  try {
    if (!(await repositoryPool(repositoryId))) return null;
    const size = sessionSandboxSize(row) ?? (await sizeForSession(row));
    const internetAccess = row.settings?.internetAccess !== false;
    const ready = await db().select(BOX_COLUMNS).from(boxes)
      .where(and(eq(boxes.repositoryId, repositoryId), eq(boxes.workspaceId, row.workspaceId), eq(boxes.status, 'ready')))
      .orderBy(asc(boxes.readyAt));
    const expectedHashes = new Map(await Promise.all([...new Set(ready.map((box) => box.agent))].map(async (agent) => [
      agent,
      await warmSpecHash({
        workspaceId: row.workspaceId,
        repositoryId,
        slug: row.repoFullName,
        baseBranch: row.baseBranch,
        agent,
        size,
        internetAccess,
      }),
    ] as const)));
    const fits = ready.filter((box) => (box.agent === row.agent || hasBothAgents(box)) && box.size === size
      && box.internetAccess === internetAccess && box.baseBranch === row.baseBranch
      && box.specHash === expectedHashes.get(box.agent));
    for (const candidate of fits) {
      const now = new Date();
      const [box] = await db()
        .update(boxes)
        .set({ status: 'claimed', claimedAt: now, claimedBy: row.id, endedAt: now, endReason: 'claimed' })
        .where(and(eq(boxes.id, candidate.id), eq(boxes.status, 'ready')))
        .returning(BOX_COLUMNS);
      if (!box) continue;
      const claim = await handOver(row, box);
      if (claim) return claim;
    }
    await noteMiss(row, ready.length === 0 ? 'none_ready' : fits.length === 0 ? 'no_match' : 'taken', { size, internetAccess });
  } catch (error) {
    note('warm_pool_claim_failed', `claiming a warm box for ${row.id} failed; creating a fresh one`, {
      workspaceId: row.workspaceId, workbenchId: row.id,
    }, false, error);
  }
  kickWarmPool();
  return null;
}

function hasBothAgents(box: WarmBox): boolean {
  const agents = (box.record as { credentialAgents?: string[] } | null)?.credentialAgents;
  return !!agents?.includes('claude') && agents.includes('codex');
}

/**
 * Give the claimed box to the session: its Talyn MCP token and its own
 * credentials, before anything runs in the box. A failure ends the box (it
 * may hold half a push) and is a miss.
 */
async function handOver(row: WorkbenchRow, box: WarmBox): Promise<WarmClaim | null> {
  try {
    // Mints the session's token, which the push below then carries.
    await talynMcpServerFor(row);
    const client = await fleetClientFor(row.workspaceId, box.fleetHost);
    await pushSessionCredentials(row, box.sandboxId, client);
    const agents = (box.record as { credentialAgents?: ('claude' | 'codex')[] } | null)?.credentialAgents
      ?? [box.agent === 'codex' ? 'codex' : 'claude'];
    await recordSandboxAgents(row, box.sandboxId, agents);
    const { legacyUserStepIds, ...layer } = (box.record ?? {}) as { legacyUserStepIds?: string[] } & Record<string, unknown>;
    const fillMs = box.fillMs ?? null;
    const ageMs = box.readyAt ? Date.now() - box.readyAt.getTime() : null;
    await recordBootMetric(row.id, 'warm_pool', { hit: true, sandboxId: box.sandboxId, fillMs, ageMs }).catch(() => undefined);
    note('warm_pool_hit', `session ${row.id.slice(0, 8)} took warm box ${box.sandboxId}`, {
      workspaceId: row.workspaceId, workbenchId: row.id, repositoryId: box.repositoryId, sandboxId: box.sandboxId, fillMs, ageMs,
    });
    kickWarmPool();
    return {
      box,
      fillMs,
      created: {
        ok: true,
        sandboxId: box.sandboxId,
        fleetHost: box.fleetHost,
        fleetSandboxId: box.fleetSandboxId,
        size: box.size as SandboxSize,
        record: { status: 'idle', ...layer } as Extract<CreatedWorkbenchSandbox, { ok: true }>['record'],
        legacyUserStepIds: Array.isArray(legacyUserStepIds) ? legacyUserStepIds : [],
        client,
      },
    };
  } catch (error) {
    note('warm_pool_handover_failed', `handing ${box.sandboxId} to ${row.id.slice(0, 8)} failed; creating a fresh box`, {
      workspaceId: row.workspaceId, workbenchId: row.id, sandboxId: box.sandboxId,
    }, false, error);
    await db().update(boxes).set({ status: 'discarding', endedAt: null, endReason: 'handover_failed' })
      .where(and(eq(boxes.id, box.id), eq(boxes.status, 'claimed')));
    await deleteDiscarded({ ...box, status: 'discarding' });
    await noteMiss(row, 'handover_failed', {});
    return null;
  }
}

async function noteMiss(row: WorkbenchRow, reason: string, meta: Record<string, unknown>): Promise<void> {
  await recordBootMetric(row.id, 'warm_pool', { hit: false, reason, ...meta }).catch(() => undefined);
  note('warm_pool_miss', `no warm box for session ${row.id.slice(0, 8)}: ${reason}`, {
    workspaceId: row.workspaceId, workbenchId: row.id, repositoryId: row.repositoryId, reason, ...meta,
  });
}

/** The claimed session is ready. Records what the claim saved. Never throws. */
export async function noteWarmStartReady(row: Pick<WorkbenchRow, 'id' | 'workspaceId'>, claim: WarmClaim, readyMs: number): Promise<void> {
  const savedMs = claim.fillMs === null ? null : Math.max(0, claim.fillMs - readyMs);
  await recordBootMetric(row.id, 'warm_pool_ready', { sandboxId: claim.box.sandboxId, readyMs, fillMs: claim.fillMs, savedMs })
    .catch(() => undefined);
  note('warm_pool_ready_session', `session ${row.id.slice(0, 8)} ready on warm box ${claim.box.sandboxId} in ${readyMs} ms (saved ${savedMs ?? '?'} ms)`, {
    workspaceId: row.workspaceId, workbenchId: row.id, sandboxId: claim.box.sandboxId, readyMs, fillMs: claim.fillMs, savedMs,
  });
}

// ============================================================================
// The sweep: refill, keep alive, refresh, yield
// ============================================================================

interface PoolEntry {
  repositoryId: string;
  workspaceId: string;
  config: WarmPoolConfig;
}

async function configuredPools(): Promise<Map<string, PoolEntry>> {
  const rows = await db()
    .select({ id: repositories.id, workspaceId: repositories.workspaceId, settings: repositories.settings })
    .from(repositories)
    .where(sql`${repositories.settings} ? 'warmPool'`);
  const out = new Map<string, PoolEntry>();
  for (const row of rows) {
    const config = warmPoolConfig(row.settings);
    if (config) out.set(row.id, { repositoryId: row.id, workspaceId: row.workspaceId, config });
  }
  return out;
}

async function liveBoxes(repositoryId?: string): Promise<WarmBox[]> {
  return db().select(BOX_COLUMNS).from(boxes)
    .where(and(isNull(boxes.endedAt), repositoryId ? eq(boxes.repositoryId, repositoryId) : undefined))
    .orderBy(asc(boxes.createdAt));
}

let running: Promise<void> | null = null;
let again = false;

/** The poller's tick. One at a time per process; the maintenance claim makes it one across replicas. */
export function warmPoolTick(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await sweepWarmPool();
      } while (again && !isWorkbenchDraining());
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Refill soon: after a claim or a miss. */
export function kickWarmPool(): void {
  void runWithoutScope(() => warmPoolTick()).catch((error) => note('warm_pool_sweep_failed', 'the warm pool sweep failed', {}, false, error));
}

/** Tests wait for a kicked sweep. */
export async function settleWarmPoolForTests(): Promise<void> {
  while (running) await running;
}

export async function sweepWarmPool(): Promise<void> {
  if (isWorkbenchDraining()) return;
  await withMaintenanceClaim(WARM_POOL_POLLER, async (renew) => {
    const pools = await configuredPools();
    const hosts = await listFleetHosts().catch(() => [] as FleetHostView[]);
    const live = await liveBoxes();
    const kept = new Map<string, number>();
    for (const box of live) {
      if (isWorkbenchDraining()) return;
      await renew();
      if (box.status === 'discarding') {
        await deleteDiscarded(box);
        continue;
      }
      // Only this claim fills, so a box still filling belongs to a filler that died.
      if (box.status === 'filling') {
        await discardBox(box, 'fill_abandoned');
        continue;
      }
      const pool = pools.get(box.repositoryId);
      const count = kept.get(box.repositoryId) ?? 0;
      const reason = !pool || pool.config.agent !== box.agent ? 'pool_changed'
        : count >= pool.config.slots ? 'over_slots'
          : await staleReason(box, hosts);
      if (reason) {
        await discardBox(box, reason);
        continue;
      }
      kept.set(box.repositoryId, count + 1);
    }
    for (const pool of pools.values()) {
      while (!isWorkbenchDraining() && (kept.get(pool.repositoryId) ?? 0) < pool.config.slots) {
        await renew();
        if (!(await fillOne(pool, hosts, renew))) break;
        kept.set(pool.repositoryId, (kept.get(pool.repositoryId) ?? 0) + 1);
      }
    }
  });
}

/** Why a ready box must go, or null to keep it. Keeps it awake as a side effect. */
async function staleReason(box: WarmBox, hosts: FleetHostView[]): Promise<string | null> {
  const now = Date.now();
  if (now - box.createdAt.getTime() > WARM_POOL.maxAgeMs) return 'aged';
  const host = box.fleetHost ? hosts.find((h) => h.name === box.fleetHost) : undefined;
  if (host && !hostHasRoomForPool(host)) return 'yielded';

  const client = await fleetClientFor(box.workspaceId, box.fleetHost);
  if (!box.touchedAt || now - box.touchedAt.getTime() >= WARM_POOL.keepAliveMs) {
    try {
      const { sandbox } = await client.getSandbox(box.sandboxId);
      // A box the fleet put to sleep would wake on the claim, slowly, and its resume needs a session's credentials.
      if (!sandbox || !BOOTED.has(sandbox.status)) return `not_awake:${sandbox?.status ?? 'unknown'}`;
      const alive = await runCapture(boxRow(box, ''), 'true', { cwd: '/', timeoutMs: 30_000, quiet: true });
      if (alive.exitCode !== 0) return 'keepalive_failed';
    } catch (error) {
      if (error instanceof FleetRunNotFoundError) return 'lost';
      throw error;
    }
    await db().update(boxes).set({ touchedAt: new Date() }).where(eq(boxes.id, box.id));
  }

  if (box.checkedAt && now - box.checkedAt.getTime() < WARM_POOL.checkMs) return null;
  const repo = await resolveRepository(box.repositoryId, box.workspaceId);
  if (!repo) return 'repository_gone';
  if (repo.defaultBranch !== box.baseBranch) return 'default_branch_changed';
  const size = await sizeForSession({ repositoryId: box.repositoryId, workspaceId: box.workspaceId });
  const hash = await warmSpecHash({
    workspaceId: box.workspaceId, repositoryId: box.repositoryId, slug: repo.slug, baseBranch: box.baseBranch,
    agent: box.agent, size, internetAccess: box.internetAccess,
  });
  if (hash !== box.specHash) return 'spec_changed';
  const drift = await baseDrift(box, repo.slug);
  if (drift) return drift;
  await db().update(boxes).set({ checkedAt: new Date() }).where(eq(boxes.id, box.id));
  return null;
}

/**
 * Whether the default branch moved past what the box installed: a dependency
 * or setup file changed, or it moved too far to tell. A failed read keeps the
 * box; the next check asks again.
 */
async function baseDrift(box: WarmBox, slug: string): Promise<string | null> {
  if (!box.checkoutCommit) return null;
  const [owner, name] = slug.split('/');
  if (!owner || !name) return null;
  try {
    const compared = await githubService.compareCommits(box.workspaceId, owner, name, box.checkoutCommit, box.baseBranch);
    if (!compared) return 'base_rewritten';
    if (compared.files.length >= COMPARE_FILE_LIMIT) return 'base_moved';
    const changed = compared.files.find((f) => DEPENDENCY_FILE.test(f.filename) || DEPENDENCY_FILE.test(f.previous_filename ?? ''));
    return changed ? `dependencies_changed:${changed.filename}` : null;
  } catch (error) {
    note('warm_pool_drift_check_failed', `could not compare ${box.sandboxId}'s checkout with ${box.baseBranch}`, {
      workspaceId: box.workspaceId, sandboxId: box.sandboxId,
    }, false, error);
    return null;
  }
}

/**
 * Create, check out and set up one box. True when it is ready. Every refusal
 * is a logged false: the next sweep tries again.
 */
async function fillOne(pool: PoolEntry, hosts: FleetHostView[], renew: () => Promise<void>): Promise<boolean> {
  const { repositoryId, workspaceId } = pool;
  const meta = { workspaceId, repositoryId };
  if (!hosts.some((h) => hostHasRoomForPool(h))) {
    note('warm_pool_skip', `not filling ${repositoryId}: no host has the pool's reserve free`, meta);
    return false;
  }
  if (await yieldedRecently()) return false;
  const repo = await resolveRepository(repositoryId, workspaceId);
  if (!repo) return false;
  const size = await sizeForSession({ repositoryId, workspaceId });
  try {
    // A box for an account that could not start one would never be claimed.
    await assertNewWorkbenchBox(workspaceId, size);
  } catch (error) {
    if (!isBoxGateError(error)) throw error;
    note('warm_pool_skip', `not filling ${repositoryId}: the plan refuses a new box`, meta);
    return false;
  }
  const shape: WarmShape = {
    workspaceId, repositoryId, slug: repo.slug, baseBranch: repo.defaultBranch, agent: pool.config.agent, size, internetAccess: true,
  };
  const specHash = await warmSpecHash(shape);
  const id = randomUUID();
  const sandboxId = warmSandboxId(id);
  const startedAt = Date.now();
  const [inserted] = await db().insert(boxes).values({
    id, sandboxId, workspaceId, repositoryId, agent: shape.agent, size, internetAccess: true,
    baseBranch: shape.baseBranch, specHash, status: 'filling',
  }).returning(BOX_COLUMNS);
  let box: WarmBox = inserted;
  note('warm_pool_fill', `filling ${sandboxId} for ${repo.slug}`, { ...meta, sandboxId });

  let lost = false;
  const timer = setInterval(() => { void renew().catch(() => { lost = true; }); }, 20_000);
  timer.unref();
  const stillOurs = () => !lost && !isWorkbenchDraining();
  try {
    const { createWorkbenchSandbox } = await import('./lifecycle.js');
    const created = await createWorkbenchSandbox(boxRow({ ...box, fleetHost: null }, repo.slug), sandboxId, { warm: true });
    if (!created.ok) {
      await discardBox(box, 'create_refused');
      note('warm_pool_skip', `the fleet refused ${sandboxId}: ${created.error}`, meta, false);
      return false;
    }
    const record = { ...created.record, legacyUserStepIds: created.legacyUserStepIds };
    const [placed] = await db().update(boxes)
      .set({ fleetHost: created.fleetHost, fleetSandboxId: created.fleetSandboxId, size: created.size, record })
      .where(and(eq(boxes.id, id), eq(boxes.status, 'filling')))
      .returning(BOX_COLUMNS);
    if (!placed) {
      // Discarded while the create ran, before the row named a host: delete what the create made.
      await (await fleetClientFor(workspaceId, created.fleetHost)).deleteSandbox(sandboxId).catch(() => undefined);
      return false;
    }
    box = placed;
    if (!created.record.status || !BOOTED.has(created.record.status)) {
      await discardBox(box, `not_booted:${created.record.status ?? 'unknown'}`);
      return false;
    }
    const host = created.fleetHost ? (await listFleetHosts().catch(() => hosts)).find((h) => h.name === created.fleetHost) : undefined;
    if (host && !hostHasRoomForPool(host)) {
      await discardBox(box, 'yielded');
      return false;
    }
    if (!stillOurs()) return false;

    const row = boxRow(box, repo.slug);
    const boxLayer = boxLayerContextFrom(created.record, created.legacyUserStepIds);
    const checkout = await runCapture(row, cloneScript(row, {
      boxLayer, prebakedCheckout: created.record.prebakedCheckout, warm: true,
    }), { cwd: '/', timeoutMs: WARM_POOL.scriptTimeoutMs });
    if (checkout.exitCode !== 0) {
      await discardBox(box, 'checkout_failed');
      note('warm_pool_skip', `checking out ${repo.slug} on ${sandboxId} failed: ${checkout.stderr.trim().split('\n').slice(-2).join(' ')}`, meta, false);
      return false;
    }
    const commit = checkout.stdout.trim().split('\n').pop()?.trim() ?? '';
    if (!stillOurs()) return false;
    await renew();

    // The session's own setup on the base, so the claim's run finds the work done.
    const config = await loadWorkbenchConfig(row);
    const setup = config ? commandFor(config, 'setup') : null;
    let setupExit: number | null = null;
    if (setup) {
      const ran = await runCapture(row, setup.command, {
        env: sandboxScriptEnv(row), timeoutMs: WARM_POOL.scriptTimeoutMs, quiet: true,
      });
      setupExit = ran.exitCode;
    }
    if (!stillOurs()) return false;
    const now = new Date();
    const fillMs = Date.now() - startedAt;
    const [ready] = await db().update(boxes)
      .set({
        status: 'ready', readyAt: now, touchedAt: now, checkedAt: now, setupExit, fillMs,
        checkoutCommit: /^[0-9a-f]{40,64}$/i.test(commit) ? commit : null,
      })
      .where(and(eq(boxes.id, id), eq(boxes.status, 'filling')))
      .returning(BOX_COLUMNS);
    if (!ready) return false;
    note('warm_pool_ready', `${sandboxId} is ready for ${repo.slug} after ${fillMs} ms (setup exit ${setupExit ?? 'none'})`, {
      ...meta, sandboxId, fillMs, setupExit, layer: boxLayer.layer, host: created.fleetHost,
    }, setupExit === null || setupExit === 0);
    return true;
  } catch (error) {
    note('warm_pool_fill_failed', `filling ${sandboxId} failed`, { ...meta, sandboxId }, false, error);
    await discardBox(box, 'fill_failed').catch(() => undefined);
    return false;
  } finally {
    clearInterval(timer);
  }
}
