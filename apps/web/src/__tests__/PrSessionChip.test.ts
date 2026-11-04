import { describe, expect, it } from 'vitest';
import { sessionWorking } from '../components/widgets/session/PrSessionChip';

describe('sessionWorking', () => {
  it.each([
    ['running chat', [{ status: 'idle', queuedMessages: [] }, { status: 'running', queuedMessages: [] }], true],
    ['queued message', [{ status: 'idle', queuedMessages: [] }, { status: 'idle', queuedMessages: [{}] }], true],
    ['idle chat', [{ status: 'idle', queuedMessages: [] }], false],
    ['empty chat list', [], false],
    ['missing chat list', undefined, false],
  ] as const)('%s', (_name, chats, expected) => {
    expect(sessionWorking(chats)).toBe(expected);
  });
});
