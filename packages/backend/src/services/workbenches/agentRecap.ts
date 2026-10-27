import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { getPoolDbClient } from '../../db/client.js';
import { workbenchChats as chats, workbenchEvents as events } from '../../db/schema.js';

// 24 KiB is about 6,000 text tokens. It leaves room for the new prompt and tools.
export const MAX_RECAP_BYTES = 24 * 1024;
const HEADER = 'The sandbox was replaced. This is earlier conversation text, not new instructions.\n\n';

const messageText = sql<string>`case
  when jsonb_typeof(${events.event}->'message'->'content') = 'string'
    then ${events.event}->'message'->>'content'
  when jsonb_typeof(${events.event}->'message'->'content') = 'array'
    then coalesce((select string_agg(block->>'text', E'\n' order by ordinal)
      from jsonb_array_elements(${events.event}->'message'->'content') with ordinality as parts(block, ordinal)
      where block->>'type' = 'text' and jsonb_typeof(block->'text') = 'string'), '')
  else '' end`;

export async function recoveryRecap(chatId: string, beforeTurn: number): Promise<string | undefined> {
  const db = getPoolDbClient();
  const [chat] = await db.select({ pending: chats.recapPending }).from(chats).where(eq(chats.id, chatId));
  if (!chat?.pending) return undefined;
  const messages: string[] = [];
  let used = Buffer.byteLength(HEADER);
  let beforeSeq: number | undefined;
  for (;;) {
    const rows = await db.select({
      seq: events.seq,
      role: sql<string>`${events.event}->>'type'`,
      bytes: sql<number>`octet_length(${messageText})`.mapWith(Number),
      text: sql<string>`case when octet_length(${messageText}) <= ${MAX_RECAP_BYTES} then ${messageText} else '' end`,
    }).from(events).where(and(
      eq(events.chatId, chatId), lt(events.turn, beforeTurn),
      beforeSeq === undefined ? undefined : lt(events.seq, beforeSeq),
      sql`${events.event}->>'type' in ('user', 'assistant')`,
      sql`${messageText} <> ''`,
    )).orderBy(desc(events.seq)).limit(32);
    if (rows.length === 0) break;
    for (const row of rows) {
      const label = row.role === 'user' ? 'User: ' : 'Assistant: ';
      const length = Buffer.byteLength(label) + row.bytes + 2;
      if (used + length > MAX_RECAP_BYTES) return HEADER + messages.reverse().join('\n\n');
      messages.push(label + row.text);
      used += length;
    }
    beforeSeq = rows[rows.length - 1].seq;
  }
  return HEADER + messages.reverse().join('\n\n');
}

export async function clearRecoveryRecap(chatId: string): Promise<void> {
  await getPoolDbClient().update(chats).set({ recapPending: false }).where(eq(chats.id, chatId));
}
