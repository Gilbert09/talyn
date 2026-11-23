import type { AgentEvent, ToolBlock, WorkbenchEvent } from '@talyn/shared';

import { fullToolFrom, toolSeq } from '../features/chat/fullTool';
import { sameRow, TranscriptRowCache, transcriptRows, type TranscriptRow } from '../features/chat/transcript';
import {
  emptyTranscript, EVENT_BYTES, EVENT_LIMIT, mergeEvents, READING_SLACK, RELEASE_AT, RELEASE_KEEP, releaseOlder, windowFull,
  type Transcript,
} from '../workflow/model';
import { eventSize, isSlim, MESSAGE_TEXT_CAP, SLIM_MARK, slimEvent, slimTools, TOOL_BUDGET, TOOL_TEXT_CAP } from '../workflow/slim';
import { event } from './workflowFixtures';

const CHAT = 'chat-one';
const raw = (seq: number, body: Record<string, unknown>, turn = 1): WorkbenchEvent =>
  ({ chatId: CHAT, seq, turn, createdAt: '2026-11-08T11:00:00Z', event: { seq, ...body } as AgentEvent });
const text = (seq: number, words: string, turn = 1) => raw(seq, { type: 'assistant', message: { content: [{ type: 'text', text: words }] } }, turn);
const call = (seq: number, id: string, input: unknown, turn = 1) =>
  raw(seq, { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input }] } }, turn);
const result = (seq: number, id: string, content: unknown, turn = 1) =>
  raw(seq, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } }, turn);
const person = (seq: number, words: string, turn: number) =>
  raw(seq, { type: 'user', talyn_user_message: true, message: { content: [{ type: 'text', text: words }] } }, turn);
const range = (from: number, to: number, make: (seq: number) => WorkbenchEvent = (seq) => event(seq)) =>
  Array.from({ length: to - from + 1 }, (_, index) => make(from + index));
const seqs = (t: Transcript) => t.events.map((item) => item.seq);
const recount = (t: Transcript) => t.events.reduce((total, item) => total + eventSize(item), 0);
/** The newest page of a history that holds seqs 1..newest. */
const latestPage = (from: number, to: number, make?: (seq: number) => WorkbenchEvent) =>
  mergeEvents(CHAT, emptyTranscript(), range(from, to, make), 'rest', { events: [], cursor: to, oldestSeq: from, hasOlder: from > 1 });
const olderPage = (current: Transcript, from: number, to: number, make?: (seq: number) => WorkbenchEvent, reading?: 'newest' | 'older') =>
  mergeEvents(CHAT, current, range(from, to, make), 'older', { events: [], cursor: to, oldestSeq: from, hasOlder: from > 1 }, reading);
/** An event of about `chars` characters of message text. */
const big = (chars: number) => (seq: number) => text(seq, 'x'.repeat(chars));

describe('slimming events at ingest', () => {
  const huge = 'y'.repeat(TOOL_TEXT_CAP * 10);
  it.each([
    ['a short agent message', text(1, 'Hello'), false],
    ['a short tool call', call(1, 't1', { command: 'npm test' }), false],
    ['a short tool result', result(1, 't1', 'ok'), false],
  ])('keeps %s as the same object', (_name, item, cut) => {
    const slim = slimEvent(item);
    expect(slim === item).toBe(!cut);
    expect(slimTools(slim.event)).toEqual([]);
  });
  it.each([
    ['a long string result', result(1, 't1', huge), 't1'],
    ['a long array result', result(1, 't1', [{ type: 'text', text: huge }, { type: 'text', text: huge }]), 't1'],
    ['a long call input', call(1, 't1', { command: 'cat', content: huge }), 't1'],
    ['a result with many items', result(1, 't1', Array.from({ length: 1000 }, (_, index) => ({ type: 'text', text: `line ${index}` }))), 't1'],
  ])('cuts %s to a preview and marks the tool', (_name, item, id) => {
    const slim = slimEvent(item);
    expect(slim).not.toBe(item);
    expect(slimTools(slim.event)).toEqual([id]);
    expect(JSON.stringify(slim.event).length).toBeLessThan(TOOL_BUDGET + 4000);
    expect(eventSize(slim)).toBeLessThan(TOOL_BUDGET * 2);
  });
  it('keeps the start of a cut result', () => {
    const slim = slimEvent(result(1, 't1', `first line\n${huge}`));
    const block = (slim.event.message!.content as Array<{ content: string }>)[0];
    expect(block.content.startsWith('first line\n')).toBe(true);
    expect(block.content).toHaveLength(TOOL_TEXT_CAP);
  });
  it.each([
    ['agent text', text(1, 'z'.repeat(MESSAGE_TEXT_CAP + 10))],
    ['a person message', person(1, 'z'.repeat(MESSAGE_TEXT_CAP + 10), 1)],
  ])('keeps %s whole up to the message cap', (_name, item) => {
    const slim = slimEvent(item);
    const block = (slim.event.message!.content as Array<{ text: string }>)[0];
    expect(block.text).toHaveLength(MESSAGE_TEXT_CAP);
    expect(slimTools(slim.event)).toEqual([]);
  });
  it('keeps message text under the cap whole even next to a long tool result', () => {
    const item = raw(1, { type: 'assistant', message: { content: [{ type: 'text', text: 'w'.repeat(20000) }, { type: 'tool_use', id: 't9', name: 'Write', input: { file_path: '/a', content: huge } }] } });
    const content = slimEvent(item).event.message!.content as Array<{ text?: string; input?: { content: string } }>;
    expect(content[0].text).toHaveLength(20000);
    expect(content[1].input!.content).toHaveLength(TOOL_TEXT_CAP);
  });
  it('drops image data and thinking signatures, which are never drawn', () => {
    const slim = slimEvent(raw(1, { type: 'assistant', message: { content: [
      { type: 'thinking', thinking: 'Considering', signature: 's'.repeat(5000) },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(500000) } },
    ] } }));
    const content = slim.event.message!.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'thinking', thinking: 'Considering' });
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64' } });
    expect(eventSize(slim)).toBeLessThan(2000);
  });
  it('cuts a permission request input', () => {
    const slim = slimEvent(raw(1, { type: 'talyn_permission_request', requestId: 'r', tool_name: 'Write', tool_input: { content: huge } }));
    expect((slim.event.tool_input as { content: string }).content).toHaveLength(TOOL_TEXT_CAP);
  });
  it('is idempotent and never changes the original event', () => {
    const item = result(1, 't1', huge);
    const before = JSON.stringify(item);
    const slim = slimEvent(item);
    expect(slimEvent(slim)).toBe(slim);
    expect(isSlim(slim)).toBe(true);
    expect(JSON.stringify(item)).toBe(before);
    expect(slim.event[SLIM_MARK]).toEqual({ tools: ['t1'] });
  });
  it('keeps an unreadable event as a stub instead of throwing', () => {
    const item = raw(1, { type: 'assistant' });
    Object.defineProperty(item.event, 'message', { enumerable: true, get() { throw new Error('bad'); } });
    const slim = slimEvent(item);
    expect(slim.seq).toBe(1);
    expect(slim.event).toMatchObject({ type: 'system', subtype: 'talyn_mobile_unreadable' });
  });
});

describe('the transcript window', () => {
  it.each([
    ['live append', (t: Transcript) => mergeEvents(CHAT, t, range(11, 12)), [1, 12]],
    ['live replace', (t: Transcript) => mergeEvents(CHAT, t, [text(5, 'changed')]), [1, 10]],
    ['rest overlap', (t: Transcript) => mergeEvents(CHAT, t, range(8, 14), 'rest'), [1, 14]],
    ['out of order live', (t: Transcript) => mergeEvents(CHAT, t, [event(12), event(11)]), [1, 12]],
  ])('merges a %s and keeps bytes exact', (_name, apply, [first, last]) => {
    const next = apply(latestPage(1, 10));
    expect(seqs(next)).toEqual(range(first, last).map((item) => item.seq));
    expect(next.bytes).toBe(recount(next));
    expect(next.gap).toBe(false);
  });
  it.each([
    ['live', 'live' as const], ['rest', 'rest' as const],
  ])('returns the same window for a repeated %s merge', (_name, mode) => {
    const current = latestPage(1, 10);
    expect(mergeEvents(CHAT, current, current.events, mode)).toBe(current);
    expect(mergeEvents(CHAT, current, [], mode)).toBe(current);
  });
  it('keeps the last copy of a seq within one batch', () => {
    const next = mergeEvents(CHAT, latestPage(1, 2), [text(3, 'first'), text(3, 'second')]);
    expect((next.events[2].event.message!.content as Array<{ text: string }>)[0].text).toBe('second');
  });
  it.each([
    ['a missing middle', [1, 2, 4], 2, true],
    ['a contiguous run', [1, 2, 3], 3, false],
    ['a run after a page boundary', [5, 6], 6, false],
  ])('tracks the cursor across %s', (_name, list, cursor, gap) => {
    const next = mergeEvents(CHAT, latestPage(list[0], list[0]), list.slice(1).map((seq) => event(seq)));
    expect(next.cursor).toBe(cursor); expect(next.gap).toBe(gap);
  });
  it.each([
    ['the first backward page', () => latestPage(201, 400), true],
    ['the first page of a short chat', () => latestPage(1, 50), false],
    ['an older page that reaches the start', () => olderPage(latestPage(201, 400), 1, 200), false],
    ['an older page with more below', () => olderPage(latestPage(401, 600), 201, 400), true],
    ['a live event after a backward page', () => mergeEvents(CHAT, latestPage(201, 400), [event(401)]), true],
  ])('reports hasOlder for %s', (_name, build, hasOlder) => {
    expect(build().hasOlder).toBe(hasOlder);
  });
  it('anchors on a REST page and not on socket events alone', () => {
    expect(mergeEvents(CHAT, emptyTranscript(), [event(9)]).anchored).toBe(false);
    expect(latestPage(9, 10).anchored).toBe(true);
  });

  describe('when a cap applies', () => {
    const chars = 40_000;
    const fits = Math.floor(EVENT_BYTES / eventSize(slimEvent(big(chars)(1))));
    it('pages a long session back to its start, newest events kept', () => {
      let t = latestPage(4801, 5000);
      for (let to = 4800; to > 0; to -= 200) t = olderPage(t, to - 199, to);
      expect(t.events).toHaveLength(5000); expect(t.events[0].seq).toBe(1); expect(t.events.at(-1)?.seq).toBe(5000);
      expect(t.hasOlder).toBe(false); expect(t.limited).toBe(false); expect(t.bytes).toBe(recount(t));
    });
    it('never drops the newest events while the reader scrolls up past the byte budget', () => {
      const newest = fits + 600;
      let t = latestPage(newest - 199, newest, big(chars));
      for (let to = newest - 200; to > 0 && !t.limited; to -= 200) t = olderPage(t, Math.max(1, to - 199), to, big(chars), 'older');
      expect(t.events.at(-1)?.seq).toBe(newest);
      expect(t.bytes).toBeLessThanOrEqual(EVENT_BYTES);
      expect(t.limited).toBe(true); expect(t.hasOlder).toBe(true);
      expect(windowFull(t)).toBe(true);
      // A full window takes no more of an older page.
      const again = olderPage(t, t.events[0].seq - 200, t.events[0].seq - 1, big(chars));
      expect(seqs(again)).toEqual(seqs(t));
    });
    it('drops the oldest events for live growth while the reader is at the newest', () => {
      const t = mergeEvents(CHAT, latestPage(1, EVENT_LIMIT), range(EVENT_LIMIT + 1, EVENT_LIMIT + 10));
      expect(t.events).toHaveLength(EVENT_LIMIT); expect(t.events[0].seq).toBe(11); expect(t.hasOlder).toBe(true);
      expect(t.bytes).toBe(recount(t));
    });
    it.each([
      ['inside the reading slack keeps every event', Math.floor(EVENT_LIMIT * (READING_SLACK - 1)) - 1, 1],
      ['past the reading slack trims to the budget', Math.floor(EVENT_LIMIT * (READING_SLACK - 1)) + 10, Math.floor(EVENT_LIMIT * (READING_SLACK - 1)) + 11],
    ])('while the reader is in older history, live growth %s', (_name, extra, oldest) => {
      const t = mergeEvents(CHAT, latestPage(1, EVENT_LIMIT), range(EVENT_LIMIT + 1, EVENT_LIMIT + extra), 'live', undefined, 'older');
      expect(t.events[0].seq).toBe(oldest);
      expect(t.events.at(-1)?.seq).toBe(EVENT_LIMIT + extra);
    });
    it.each([
      ['a window under the release bound', RELEASE_AT, false, RELEASE_AT],
      ['a window over the release bound', RELEASE_AT + 1, false, RELEASE_KEEP],
      ['a limited window', 300, true, 300],
    ])('releases %s when the reader returns to the newest', (_name, count, limited, kept) => {
      const t = { ...latestPage(1, count), limited };
      const next = releaseOlder(t);
      expect(next.events).toHaveLength(kept); expect(next.events.at(-1)?.seq).toBe(count);
      expect(next.limited).toBe(false); expect(next.bytes).toBe(recount(next));
      if (kept === count && !limited) expect(next).toBe(t);
      if (kept < count) expect(next.hasOlder).toBe(true);
    });
  });
});

describe('conversation rows', () => {
  const session = () => [
    person(1, 'Fix the build', 1), text(2, 'Looking'), call(3, 't1', { command: 'npm test' }), result(4, 't1', 'y'.repeat(TOOL_TEXT_CAP * 3)),
    text(5, 'Done'), person(6, 'Thanks', 2), text(7, 'Welcome', 2),
  ].map(slimEvent);
  it('marks the tool rows whose call or result is a preview', () => {
    const rows = transcriptRows(CHAT, session());
    const tool = rows.find((row) => row.kind === 'tool') as Extract<TranscriptRow, { kind: 'tool' }>;
    expect(tool.partial).toBe(true);
    expect(transcriptRows(CHAT, [call(3, 't2', { command: 'ls' }), result(4, 't2', 'a')]).find((row) => row.kind === 'tool'))
      .toMatchObject({ partial: false });
  });
  it('reuses every row object when the events have not changed', () => {
    const cache = new TranscriptRowCache();
    const events = session();
    const first = cache.rows(CHAT, events);
    const second = cache.rows(CHAT, [...events]);
    expect(second).toHaveLength(first.length);
    second.forEach((row, index) => expect(row).toBe(first[index]));
  });
  it('keeps settled rows when a live event lands in the open turn', () => {
    const cache = new TranscriptRowCache();
    const events = session();
    const first = cache.rows(CHAT, events);
    const next = cache.rows(CHAT, [...events, slimEvent(text(8, 'More', 2))]);
    first.forEach((row) => expect(next.find((item) => item.key === row.key)).toBe(row));
    expect(next.at(-1)).toMatchObject({ kind: 'text', text: 'More' });
  });
  it('keeps rows when an older page lands in front', () => {
    const cache = new TranscriptRowCache();
    const events = session();
    const newest = cache.rows(CHAT, events.slice(5));
    const all = cache.rows(CHAT, events);
    newest.forEach((row) => expect(all.find((item) => item.key === row.key)).toBe(row));
  });
  it('shows one notice for an unreadable turn and still draws the others', () => {
    const bad = raw(10, { type: 'assistant' }, 3);
    Object.defineProperty(bad.event, 'message', { enumerable: true, get() { throw new Error('bad'); } });
    const rows = transcriptRows(CHAT, [...session(), bad, text(11, 'After', 4)]);
    expect(rows.filter((row) => row.kind === 'broken')).toHaveLength(1);
    expect(rows.at(-1)).toMatchObject({ kind: 'text', text: 'After' });
  });
  it.each([
    ['equal tools', true],
    ['a settled tool', false],
  ])('compares rows: %s', (name, same) => {
    const tool: ToolBlock = { kind: 'tool', key: '3.0', toolId: 't', name: 'Bash', input: {}, isError: false, stopped: false, settled: false };
    const a: TranscriptRow = { key: 'k', timestamp: null, kind: 'tool', tool, partial: false };
    const b: TranscriptRow = { ...a, tool: { ...tool, settled: name === 'a settled tool' } };
    expect(sameRow(a, b)).toBe(same);
  });
});

describe('loading a whole tool call', () => {
  const tool: ToolBlock = { kind: 'tool', key: '3.0', toolId: 't1', name: 'Bash', input: { command: 'c' }, output: 'cut', isError: false, stopped: false, settled: true };
  it.each([
    ['call and result', [call(3, 't1', { command: 'full' }), result(4, 't1', 'whole')], { command: 'full' }, 'whole'],
    ['the result only', [text(3, 'x'), result(4, 't1', 'whole')], { command: 'c' }, 'whole'],
    ['the call only', [call(3, 't1', { command: 'full' })], { command: 'full' }, 'cut'],
  ])('reads %s from stored events', (_name, events, input, output) => {
    expect(fullToolFrom(tool, events)).toMatchObject({ input, output });
  });
  it('returns null when the call is not among the events', () => {
    expect(fullToolFrom(tool, [call(3, 'other', {})])).toBeNull();
  });
  it('keeps the empty output of a stopped call', () => {
    expect(fullToolFrom({ ...tool, stopped: true, output: '' }, [result(4, 't1', 'rejected')])?.output).toBe('');
  });
  it.each([['3.0', 3], ['12.4', 12], ['stream-x', null], ['0.1', null]])('reads seq %s', (key, seq) => {
    expect(toolSeq({ key })).toBe(seq);
  });
});

describe('large sessions stay fast', () => {
  /** A realistic mix: messages, tool calls, and large tool results. */
  const realistic = (seq: number): WorkbenchEvent => {
    const turn = Math.floor(seq / 100) + 1;
    switch (seq % 5) {
      case 0: return person(seq, `Request ${seq}`, turn);
      case 1: return text(seq, `Working on it. ${'detail '.repeat(40)}`, turn);
      case 2: return call(seq, `t${seq}`, { command: `rg pattern-${seq}`, description: 'search' }, turn);
      case 3: return result(seq, `t${seq - 1}`, `${'match line\n'.repeat(4000)}`, turn);
      default: return raw(seq, { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Thinking '.repeat(50), signature: 's'.repeat(3000) }] } }, turn);
    }
  };
  it('pages, merges and builds rows for 5,000 events within budget', () => {
    const started = Date.now();
    let t = latestPage(4801, 5000, realistic);
    for (let to = 4800; to > 0; to -= 200) t = olderPage(t, to - 199, to, realistic);
    const paged = Date.now() - started;
    expect(t.events).toHaveLength(5000);
    expect(t.bytes).toBeLessThan(EVENT_BYTES / 2);

    const cache = new TranscriptRowCache();
    const rowsStarted = Date.now();
    const rows = cache.rows(CHAT, t.events);
    const built = Date.now() - rowsStarted;
    expect(rows.length).toBeGreaterThan(1000);

    // 300 live events, each merged and drawn into rows, like a busy socket.
    const liveStarted = Date.now();
    for (let seq = 5001; seq <= 5300; seq++) {
      t = mergeEvents(CHAT, t, [realistic(seq)]);
      cache.rows(CHAT, t.events);
    }
    const live = Date.now() - liveStarted;
    expect(t.events.at(-1)?.seq).toBe(5300);
    expect(t.bytes).toBe(recount(t));
    expect({ paged: paged < 4000, built: built < 2000, live: live < 3000 }).toEqual({ paged: true, built: true, live: true });
  });
});
