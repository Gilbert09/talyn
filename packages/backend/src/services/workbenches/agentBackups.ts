import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { and, asc, eq, ne, isNotNull, sql } from 'drizzle-orm';
import { shellQuote } from '@talyn/shared';
import { getPoolDbClient, runWithoutScope } from '../../db/client.js';
import { workbenchAgentBackups as backups, workbenchChats as chats, workbenches } from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { boxSessionPath, MAX_IMPORTED_SESSION_BYTES } from './claudeImport.js';
import { shellPath, writeSandboxFiles } from './sandboxFiles.js';
import { repoDirFor, runCapture } from './sandboxRuntime.js';
import { isWorkbenchDraining } from './ownership.js';
import { getChat, getWorkbench, type ChatRow, type WorkbenchRow } from './store.js';

const gunzipAsync = promisify(gunzip);
export const BACKUP_CHUNK_BYTES = 2 * 1024 * 1024;
const active = new Map<string, Promise<void>>();
const rerun = new Set<string>();
const execOptions = { cwd: '/', env: { TMPDIR: '/dev/shm' }, quiet: true, timeoutMs: 30_000, diskRecovery: false } as const;

export const BACKUP_METADATA_COLUMNS = {
  seq: backups.seq,
  startOffset: backups.startOffset,
  byteLen: backups.byteLen,
  sha256: backups.sha256,
  agent: backups.agent,
} as const;

const BACKUP_TOTAL_COLUMNS = {
  bytes: sql<number>`coalesce(sum(${backups.byteLen}), 0)`.mapWith(Number),
  nextSeq: sql<number>`coalesce(max(${backups.seq}), -1) + 1`.mapWith(Number),
} as const;

export function backupTotalsQuery(chatId: string, sessionId: string) {
  return getPoolDbClient().select(BACKUP_TOTAL_COLUMNS).from(backups)
    .where(and(eq(backups.chatId, chatId), eq(backups.sessionId, sessionId)));
}

function report(chat: ChatRow, action: string, summary: string, error?: unknown): void {
  debugBus.recordEvent({ service: 'workbench', action, summary, workspaceId: chat.workspaceId,
    ok: false, error, meta: { chatId: chat.id } });
}

/** No turn waits for this work or inherits its errors. */
export function scheduleAgentBackup(chatId: string): void {
  void runWithoutScope(() => backupAgentSession(chatId)).catch((error) => {
    debugBus.recordEvent({ service: 'workbench', action: 'agent_backup_failed',
      summary: 'The agent memory backup failed.', ok: false, error, meta: { chatId } });
  });
}

export async function settleAgentBackupsForTests(): Promise<void> {
  await Promise.allSettled([...active.values()]);
}

export function backupAgentSession(chatId: string): Promise<void> {
  const pending = active.get(chatId);
  if (pending) {
    rerun.add(chatId);
    return pending;
  }
  const work = (async () => {
    do {
      rerun.delete(chatId);
      await backupSession(chatId);
    } while (rerun.has(chatId));
  })().finally(() => {
    active.delete(chatId);
    rerun.delete(chatId);
  });
  active.set(chatId, work);
  return work;
}

/** Find Codex's rollout under its configured home, as the move export does. */
export function backupLocateScript(wb: WorkbenchRow, chat: ChatRow): string {
  const id = chat.agentSessionId!;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid agent session ID.');
  const locate = chat.agent === 'codex'
    ? `f=$(find "\${CODEX_HOME:-$HOME/.codex}/sessions" -type f -name ${shellQuote(`*${id}*.jsonl`)} -print -quit)`
    : `f=${shellPath(boxSessionPath(repoDirFor(wb), id))}`;
  return ['set -e', locate, 'test -f "$f"', 'printf "%s\\n" "$f"', 'stat -c %s -- "$f"'].join('\n');
}

export function backupReadScript(path: string, offset: number, length: number): string {
  return [
    'set -e',
    'part=$(mktemp /dev/shm/talyn-backup.XXXXXX)',
    'trap \'rm -f "$part"\' EXIT',
    `tail -c +${offset + 1} -- ${shellQuote(path)} | head -c ${length} > "$part"`,
    `test "$(stat -c %s -- "$part")" -eq ${length}`,
    'sha256sum "$part" | cut -d " " -f 1',
    'gzip -c "$part" | base64',
  ].join('\n');
}

export async function verifyBackupChunk(data: Buffer, length: number, sha256: string): Promise<Buffer> {
  if (length <= 0 || length > BACKUP_CHUNK_BYTES) throw new Error('Invalid backup chunk size.');
  const raw = await gunzipAsync(data, { maxOutputLength: BACKUP_CHUNK_BYTES });
  if (raw.length !== length || createHash('sha256').update(raw).digest('hex') !== sha256) {
    throw new Error('The agent memory checksum does not match.');
  }
  return raw;
}

async function backupSession(chatId: string): Promise<void> {
  const chat = await getChat(chatId);
  const wb = chat ? await getWorkbench(chat.workbenchId) : null;
  if (!chat?.agentSessionId || !wb?.sandboxId || wb.runtime !== 'sandbox' || wb.status !== 'ready') return;
  const db = getPoolDbClient();
  const sessionId = chat.agentSessionId;
  const where = and(eq(backups.chatId, chatId), eq(backups.sessionId, sessionId));
  const currentBox = sql`exists (select 1 from ${workbenches} where ${workbenches.id} = ${wb.id}
    and ${workbenches.sandboxId} = ${wb.sandboxId} and ${workbenches.status} = 'ready')`;
  const located = await runCapture(wb, backupLocateScript(wb, chat), execOptions);
  if (located.exitCode !== 0 || located.truncated) throw new Error('Cannot locate the agent conversation.');
  const [path, sizeText] = located.stdout.trim().split('\n');
  const size = Number(sizeText);
  if (!path?.startsWith('/') || !/^\d+$/.test(sizeText ?? '') || !Number.isSafeInteger(size)) {
    throw new Error('Invalid conversation file size or path.');
  }
  let offset = 0;
  let seq = 0;
  const generation = randomUUID();
  const metadata = { sessionId, path, byteLen: size, generation, capped: size > MAX_IMPORTED_SESSION_BYTES };
  const prepared = await db.transaction(async (tx) => {
    const [current] = await tx.select({ sessionId: chats.agentSessionId, backup: chats.agentBackup })
      .from(chats).where(and(eq(chats.id, chatId), currentBox)).for('update');
    if (current?.sessionId !== sessionId || (metadata.capped && current.backup?.capped)) return false;
    const [totals] = await tx.select(BACKUP_TOTAL_COLUMNS).from(backups).where(where);
    offset = totals.bytes;
    seq = totals.nextSeq;
    if (size < offset || (current.backup && current.backup.path !== path)) {
      await tx.delete(backups).where(where);
      offset = 0;
      seq = 0;
    }
    await tx.update(chats).set({ agentBackup: metadata }).where(eq(chats.id, chatId));
    return true;
  });
  if (!prepared) return;
  if (metadata.capped) {
    report(chat, 'agent_backup_limit', 'The conversation exceeds the 256 MiB backup limit. Backup stopped.');
    return;
  }
  // Each write checks its generation. No database lock stays open during box I/O.
  const deadline = Date.now() + 4 * 60_000;
  while (offset < size) {
    if (Date.now() >= deadline) throw new Error('The agent memory backup timed out.');
    const length = Math.min(BACKUP_CHUNK_BYTES, size - offset);
    const result = await runCapture(wb, backupReadScript(path, offset, length), execOptions);
    if (result.exitCode !== 0 || result.truncated) throw new Error('Cannot read the complete backup chunk.');
    const newline = result.stdout.indexOf('\n');
    const sha256 = result.stdout.slice(0, newline).trim();
    const data = Buffer.from(result.stdout.slice(newline + 1), 'base64');
    await verifyBackupChunk(data, length, sha256);
    const inserted = await db.transaction(async (tx) => {
      const [current] = await tx.select({ sessionId: chats.agentSessionId, backup: chats.agentBackup })
        .from(chats).where(and(eq(chats.id, chatId), currentBox)).for('update');
      if (current?.sessionId !== sessionId || current.backup?.generation !== generation) return false;
      await tx.insert(backups).values({ chatId, sessionId, agent: chat.agent, seq, startOffset: offset,
        data, byteLen: length, sha256 });
      return true;
    });
    if (!inserted) return;
    offset += length;
    seq++;
  }
}

/** Restore one chat at a time. Only this path fetches compressed bytes. */
export async function restoreAgentSession(wb: WorkbenchRow, chat: ChatRow): Promise<boolean> {
  if (!chat.agentSessionId) return false;
  const db = getPoolDbClient();
  const [state] = await db.select({ backup: chats.agentBackup }).from(chats).where(eq(chats.id, chat.id));
  const metadata = state?.backup;
  if (!metadata || metadata.capped || metadata.sessionId !== chat.agentSessionId || metadata.byteLen <= 0) return false;
  if (metadata.byteLen > MAX_IMPORTED_SESSION_BYTES || !metadata.path.startsWith('/') || metadata.path.includes('\0')) return false;
  const where = and(eq(backups.chatId, chat.id), eq(backups.sessionId, chat.agentSessionId));
  const [{ bytes }] = await backupTotalsQuery(chat.id, chat.agentSessionId);
  if (bytes !== metadata.byteLen) return false;
  const staging = `/dev/shm/talyn-memory-${randomUUID()}`;
  let offset = 0;
  let seq = 0;
  try {
    while (offset < bytes) {
      const [chunk] = await db.select({ ...BACKUP_METADATA_COLUMNS, data: backups.data }).from(backups)
        .where(and(where, eq(backups.seq, seq))).orderBy(asc(backups.seq)).limit(1);
      if (!chunk || chunk.startOffset !== offset || chunk.agent !== chat.agent) throw new Error('Incomplete agent memory backup.');
      const raw = await verifyBackupChunk(chunk.data, chunk.byteLen, chunk.sha256);
      await writeSandboxFiles(wb, [{ path: `${staging}/part`, base64: raw.toString('base64') }], {
        before: offset === 0 ? `mkdir -p ${shellQuote(staging)} && : > ${shellQuote(`${staging}/session`)}` : undefined,
        after: `cat ${shellQuote(`${staging}/part`)} >> ${shellQuote(`${staging}/session`)} && rm -f ${shellQuote(`${staging}/part`)}`,
        diskRecovery: false,
        env: { TMPDIR: '/dev/shm' },
      });
      offset += chunk.byteLen;
      seq++;
    }
    if (offset !== bytes) throw new Error('Invalid restored conversation size.');
    const target = chat.agent === 'codex' ? shellQuote(metadata.path) : shellPath(boxSessionPath(repoDirFor(wb), chat.agentSessionId));
    const result = await runCapture(wb, `set -e\nmkdir -p "$(dirname ${target})"\ncp ${shellQuote(`${staging}/session`)} ${target}`, execOptions);
    if (result.exitCode !== 0) throw new Error('Cannot install the restored conversation.');
    return true;
  } catch (error) {
    report(chat, 'agent_restore_failed', 'The agent memory could not be restored.', error);
    return false;
  } finally {
    await runCapture(wb, `rm -rf -- ${shellQuote(staging)}`, execOptions).catch(() => undefined);
  }
}

/** Retry backups whose turn ended before the previous backend could finish them. */
export async function sweepAgentBackups(): Promise<void> {
  if (isWorkbenchDraining()) return;
  const db = getPoolDbClient();
  const pending = await db.select({ id: chats.id, sessionId: chats.agentSessionId }).from(chats).innerJoin(workbenches, eq(chats.workbenchId, workbenches.id))
    .where(and(eq(chats.agentBackupPending, true), ne(chats.status, 'running'), isNotNull(chats.agentSessionId),
      eq(workbenches.status, 'ready'), isNotNull(workbenches.sandboxId))).limit(20);
  for (const chat of pending) {
    try {
      await backupAgentSession(chat.id);
      await db.update(chats).set({ agentBackupPending: false }).where(and(
        eq(chats.id, chat.id), eq(chats.agentSessionId, chat.sessionId!), ne(chats.status, 'running'),
      ));
    } catch (error) {
      debugBus.recordEvent({ service: 'workbench', action: 'agent_backup_retry',
        summary: 'The agent backup will retry.', ok: false, error });
    }
  }
}
