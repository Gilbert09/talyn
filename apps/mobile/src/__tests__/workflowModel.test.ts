import { cacheKey, canCompose, canStartSend, ciLabel, queueLabel, externalLabel, deliveryLabel, deliveryReducer, EMPTY_DELIVERY, emptyTranscript,
  EVENT_LIMIT, explicitSendFailure, failureState, groupByRepository, humanGate, mergeEvents, needsAttention, selectWorkbenches,
  stackLabel, statusLabel, transcriptRows, upsertWorkbench, withChat, workbenchTitle } from '../workflow/model';
import { chat, event, pr, scope, session } from './workflowFixtures';

describe('isolated memory keys and selectors', () => {
  it.each(['environment', 'user', 'workspace'] as const)('includes %s in every key', (field) => {
    expect(cacheKey(scope, 'transcript', 'chat')).not.toBe(cacheKey({ ...scope, [field]: 'other' }, 'transcript', 'chat'));
  });
  it('includes entity, id, and schema version without separator collisions', () => {
    expect(JSON.parse(cacheKey(scope, 'transcript', 'chat'))).toEqual(['mobile', 1, scope.environment, scope.user, scope.workspace, 'transcript', 'chat']);
    expect(cacheKey({ ...scope, environment: 'a|b', user: 'c' }, 'sessions')).not.toBe(cacheKey({ ...scope, environment: 'a', user: 'b|c' }, 'sessions'));
  });
  it('selects current work and defaults absent kinds to session', () => {
    const result = selectWorkbenches([session({ kind: undefined }), session({ id: 'foreign', workspaceId: 'two' }),
      session({ id: 'old', archivedAt: '2026-11-07' }), session({ id: 'planning', kind: 'thread' })], 'session', 'one');
    expect(result.map((item) => item.id)).toEqual(['session-one']);
    expect(workbenchTitle(session({ title: '' }))).toBe('session-one');
    expect(humanGate(session({ chats: [chat({ status: 'awaiting_input' })] }))).toBe(true);
  });
  it.each([undefined, null, 'new_provider_state', 'UNKNOWN', ''])('keeps %s unknown', (value) => expect(statusLabel(value)).toBe('Unknown'));
  it.each([['failing_required', 'Required checks failing'], ['failing_optional', 'Optional checks failing'], ['awaiting_stack', 'Waiting for stack'], ['blocked_manual', 'Human action needed']])('labels %s accurately', (state, label) => expect(statusLabel(state)).toBe(label));
  it('keeps absent stack state unknown', () => {
    expect(stackLabel(pr({ summary: { ...pr().summary, stack: undefined } }))).toBe('Unknown');
    expect(stackLabel(pr())).toBe('Standalone');
    expect(stackLabel(pr({ mergeQueue: { status: 'awaiting_stack', position: 2, stackParentNumber: 41 } }))).toBe('Based on #41');
  });
  it.each([[true, false, true], [true, true, false], [false, false, false]])('selects review request %s hidden %s', (requested, hidden, expected) => {
    expect(needsAttention(pr({ reviewRequested: requested, reviewHiddenAt: hidden ? '2026-11-08' : null }))).toBe(expected);
  });
  it('selects human gates and authored failures from existing contracts', () => {
    expect(needsAttention(pr({ reviewRequested: false, authored: true, summary: { ...pr().summary, ciStatus: 'failing_required' } }))).toBe(true);
    expect(needsAttention(pr({ reviewRequested: false, mergeQueue: { status: 'blocked_manual', position: 1 } }))).toBe(true);
    expect(needsAttention(pr({ state: 'closed' }))).toBe(false);
  });
  it.each(['ready', 'provisioning', 'moving', 'archived', 'error'] as const)('allows text only in ready state: %s', (status) => {
    expect(canCompose(session({ status }), chat())).toBe(status === 'ready');
  });
});

describe('bounded cursor reconciliation', () => {
  it('deduplicates by chat and sequence and rejects invalid events', () => {
    const result = mergeEvents('chat-one', emptyTranscript(), [event(1), event(1), event(2), event(3, { chatId: 'other' }), event(-1), event(1.5)]);
    expect(result.events.map((item) => item.seq)).toEqual([1, 2]); expect(result.cursor).toBe(2); expect(result.gap).toBe(false);
  });
  it('detects gaps without advancing past missing events', () => {
    const gap = mergeEvents('chat-one', emptyTranscript(), [event(1), event(3)]);
    expect(gap.cursor).toBe(1); expect(gap.gap).toBe(true);
    const recovered = mergeEvents('chat-one', gap, [event(2)], 'rest');
    expect(recovered.cursor).toBe(3); expect(recovered.gap).toBe(false);
  });
  it('establishes the latest REST page boundary without inventing a gap', () => {
    const result = mergeEvents('chat-one', emptyTranscript(), [event(99), event(100)], 'rest', { events: [], cursor: 100, oldestSeq: 99, hasOlder: true });
    expect(result.cursor).toBe(100); expect(result.gap).toBe(false); expect(result.hasOlder).toBe(true);
  });
  it('retains a bounded latest window for large transcripts', () => {
    const result = mergeEvents('chat-one', emptyTranscript(), Array.from({ length: 10000 }, (_, index) => event(index + 1)), 'rest');
    expect(result.events).toHaveLength(EVENT_LIMIT); expect(result.events.at(-1)?.seq).toBe(10000); expect(result.trimmed).toBe(true);
  });
  it('retains the requested older window when its history exceeds the bound', () => {
    const current = mergeEvents('chat-one', emptyTranscript(), [event(2000)], 'rest', { events: [], cursor: 2000, oldestSeq: 2000 });
    const older = mergeEvents('chat-one', current, Array.from({ length: 1999 }, (_, index) => event(index + 1)), 'older', { events: [], cursor: 1999, oldestSeq: 1, hasOlder: false });
    expect(older.events[0].seq).toBe(1); expect(older.events).toHaveLength(EVENT_LIMIT); expect(older.trimmed).toBe(true);
  });
  it('uses native rows for user text, agent text, system events, and interruptions', () => {
    const rows = transcriptRows('chat-one', [event(1, { event: { seq: 1, type: 'user', message: { content: [{ type: 'text', text: 'Hello' }] } } }),
      event(2), event(3, { event: { seq: 3, type: 'system', subtype: 'talyn_interruption' } })]);
    expect(rows.map((row) => row.author)).toEqual(['You', 'Agent', 'System']);
    expect(rows.map((row) => row.text)).toContain('Interrupted'); expect(rows[0].timestamp).toBeNull();
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });
  it('marks streamed text without announcing tokens', () => {
    const rows = transcriptRows('chat-one', [event(1, { event: { seq: 1, type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Streaming text' } } } })]);
    expect(rows[0]).toMatchObject({ author: 'Agent', text: 'Streaming text', streaming: true });
  });
});

describe('delivery and retry decisions', () => {
  it.each([[401, 'unauthorized'], [403, 'unauthorized'], [404, 'deleted'], [410, 'deleted'], [500, 'error']])('maps HTTP %s', (status, expected) => expect(failureState({ status })).toBe(expected));
  it.each([
    ['idle', false, false, true], ['sending', true, true, false], ['failed', false, false, false],
    ['failed', false, true, true], ['unknown', false, true, false], ['unknown', true, false, false], ['unknown', true, true, true],
  ] as const)('decides retry for %s checked=%s manual=%s', (status, checked, manual, expected) => {
    expect(canStartSend({ status, checked, attempt: 1 }, manual)).toBe(expected);
  });
  it.each(['ready', 'error', 'unrecognized'])('keeps foreign domain state %s unknown', (value) => {
    expect(ciLabel(value)).toBe('Unknown'); expect(queueLabel(value)).toBe('Unknown'); expect(externalLabel(value)).toBe('Unknown');
  });
  it.each([[400, true], [403, true], [409, true], [408, false], [500, false], [undefined, false]])('classifies send response %s', (status, expected) => expect(explicitSendFailure({ status })).toBe(expected));
  it('keeps sending, queued, sent, failed, and uncertain states distinct', () => {
    const sending = deliveryReducer(EMPTY_DELIVERY, { type: 'start' });
    expect(deliveryLabel(sending.status)).toBe('Sending');
    expect(deliveryLabel(deliveryReducer(sending, { type: 'ack', queued: true }).status)).toBe('Queued on server');
    expect(deliveryLabel(deliveryReducer(sending, { type: 'ack', queued: false }).status)).toBe('Sent');
    expect(deliveryLabel(deliveryReducer(sending, { type: 'failed' }).status)).toBe('Failed');
    const uncertain = deliveryReducer(sending, { type: 'unknown' });
    expect(deliveryReducer(uncertain, { type: 'reconciled' })).toMatchObject({ status: 'unknown', checked: true });
  });
});

describe('stable list order and in-place patches', () => {
  const row = (id: string, createdAt: string, repoFullName = 'example/project') => session({ id, createdAt, repoFullName, updatedAt: '2026-11-09T00:00:00Z' });
  it('orders by creation, not by last change', () => {
    const items = [row('b', '2026-11-02T00:00:00Z'), row('a', '2026-11-03T00:00:00Z'), row('c', '2026-11-02T00:00:00Z')];
    expect(selectWorkbenches(items, 'session', 'one').map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
  it.each([
    ['replaces in place', session({ title: 'New' }), true, ['session-one', 'old'], 'New'],
    ['inserts in creation order', row('new', '2026-11-09T00:00:00Z'), true, ['new', 'session-one', 'old'], 'Current work'],
    ['removes a row that left the list', session(), false, ['old'], undefined],
    ['ignores a row it does not hold and that does not belong', row('other', '2026-11-09T00:00:00Z'), false, ['session-one', 'old'], 'Current work'],
  ] as const)('upsert %s', (_name, item, belongs, ids, title) => {
    const list = [session(), row('old', '2026-11-01T00:00:00Z')];
    const next = upsertWorkbench(list, item, belongs);
    expect(next.map((value) => value.id)).toEqual(ids);
    expect(next.find((value) => value.id === 'session-one')?.title).toBe(title);
  });
  it('keeps embedded chats when an update omits them', () => {
    expect(upsertWorkbench([session()], session({ chats: undefined }), true)[0].chats).toEqual([chat()]);
  });
  it.each([
    ['replaces a known chat', chat({ status: 'running' }), ['chat-one'], 'running'],
    ['appends a new chat', chat({ id: 'chat-two' }), ['chat-one', 'chat-two'], 'idle'],
  ] as const)('withChat %s', (_name, value, ids, status) => {
    const next = withChat(session(), value);
    expect(next.chats?.map((item) => item.id)).toEqual(ids); expect(next.chats?.[0].status).toBe(status);
  });
  it('leaves a row alone for another workbench chat', () => {
    const item = session(); expect(withChat(item, chat({ workbenchId: 'other' }))).toBe(item);
  });
  it('groups by repository, newest group first, with repository-free rows in one group', () => {
    const groups = groupByRepository([row('a', '2026-11-01T00:00:00Z', 'x/one'), row('b', '2026-11-05T00:00:00Z', 'x/two'),
      row('c', '2026-11-03T00:00:00Z', 'x/one'), row('d', '2026-11-02T00:00:00Z', '')]);
    expect(groups.map((group) => [group.repo, group.items.map((item) => item.id)])).toEqual([
      ['x/two', ['b']], ['x/one', ['c', 'a']], ['', ['d']],
    ]);
  });
});
