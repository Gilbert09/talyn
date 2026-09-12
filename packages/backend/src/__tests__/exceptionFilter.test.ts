import { describe, expect, it } from 'vitest';
import {
  exceptionDropReason,
  isConnectivityMessage,
  shouldCaptureException,
  type CapturedException,
  type DropReason,
} from '@talyn/shared';

/**
 * The exception drop list, pinned.
 *
 * This filter runs in `before_send` on both front ends and DISCARDS events —
 * nothing downstream can recover what it rejects. So the tests matter in both
 * directions: every rule has cases proving it fires, and, more importantly,
 * cases proving it does not swallow a real bug that merely looks similar.
 *
 * The message strings are taken from actual captured events in the project.
 */

function ex(over: Partial<CapturedException> = {}): CapturedException {
  return { message: '', online: true, ...over };
}

describe('exceptionDropReason', () => {
  describe('offline transport failures are dropped', () => {
    const CONNECTIVITY_MESSAGES = [
      'Failed to fetch',
      'TypeError: Failed to fetch',
      'Could not reach backend: GET /environments — browser is offline',
      'NetworkError when attempting to fetch resource.',
      'Load failed',
    ];

    it.each(CONNECTIVITY_MESSAGES)('drops %j when offline', (message) => {
      expect(exceptionDropReason(ex({ message, online: false }))).toBe('offline');
    });

    it.each(CONNECTIVITY_MESSAGES)('KEEPS %j when online', (message) => {
      // `online: true` with a transport failure means the backend itself was
      // unreachable. That is the one connectivity case that can reflect a real
      // outage, so it is deliberately still captured.
      expect(exceptionDropReason(ex({ message, online: true }))).toBeNull();
    });

    it('keeps a connectivity failure when the online state is unknown', () => {
      // `null` must not be read as offline — guessing would discard real
      // failures on any runtime where the flag cannot be read.
      expect(exceptionDropReason(ex({ message: 'Failed to fetch', online: null }))).toBeNull();
    });

    it('does not drop a non-transport error just because the machine is offline', () => {
      // Being offline does not make an ordinary bug uninteresting.
      expect(
        exceptionDropReason(
          ex({ message: "Cannot read properties of undefined (reading 'toLowerCase')", online: false })
        )
      ).toBeNull();
    });
  });

  describe('Supabase auth-lock contention is dropped', () => {
    const LOCK_MESSAGES = [
      'Lock "lock:sb-xodyzfwlwvgzezwlkrqn-auth-token" was released because another request stole it',
      "AbortError: Lock broken by another request with the 'steal' option.",
      'Lock broken by another request with the "steal" option.',
    ];

    it.each(LOCK_MESSAGES)('drops %j', (message) => {
      expect(exceptionDropReason(ex({ message }))).toBe('auth-lock-contention');
    });

    it('drops it regardless of connectivity state', () => {
      const message =
        'Lock "lock:sb-xodyzfwlwvgzezwlkrqn-auth-token" was released because another request stole it';
      expect(exceptionDropReason(ex({ message, online: false }))).toBe('auth-lock-contention');
      expect(exceptionDropReason(ex({ message, online: null }))).toBe('auth-lock-contention');
    });

    it('keeps an unrelated error that merely mentions a lock', () => {
      expect(
        exceptionDropReason(ex({ message: 'Deadlock detected while acquiring the advisory lock' }))
      ).toBeNull();
    });
  });

  describe('dev-server hot-update frames are dropped', () => {
    it('drops an exception raised from a hot-update bundle', () => {
      // Autocapture is meant to be off outside packaged builds; this is the
      // second gate for a dev server started with NODE_ENV=production.
      expect(
        exceptionDropReason(
          ex({
            message:
              'Should have a queue. You are likely calling Hooks conditionally, which is not allowed.',
            sources: ['/main.dfc6caee239b57c3eedc.hot-update.js'],
          })
        )
      ).toBe('dev-hot-update');
    });

    it('drops when only one frame of several is a hot update', () => {
      expect(
        exceptionDropReason(
          ex({
            message: 'api.workflows.suggestions is not a function',
            sources: [
              'webpack://@talyn/desktop/./src/renderer/lib/api.ts',
              '/main.c6259f9925680ca2a0ba.hot-update.js',
            ],
          })
        )
      ).toBe('dev-hot-update');
    });

    it('keeps the SAME error from a packaged build', () => {
      // The message is identical — only the frame source distinguishes a real
      // production defect from a half-applied hot update.
      expect(
        exceptionDropReason(
          ex({
            message:
              'Should have a queue. You are likely calling Hooks conditionally, which is not allowed.',
            sources: ['/assets/index-B_TbwEBm.js'],
          })
        )
      ).toBeNull();
    });

    it('keeps an exception with no frames at all', () => {
      expect(exceptionDropReason(ex({ message: 'Something broke', sources: [] }))).toBeNull();
      expect(exceptionDropReason(ex({ message: 'Something broke' }))).toBeNull();
    });
  });

  describe('real bugs survive', () => {
    const KEPT: Array<[string, CapturedException]> = [
      [
        'the WebSocket send race',
        ex({
          message:
            "InvalidStateError: Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
          sources: ['webpack://@talyn/desktop/../../packages/client/dist/esm/index.js'],
        }),
      ],
      [
        'a backend that answered with an error',
        ex({ message: 'Auth check failed' }),
      ],
      [
        'an undefined property read',
        ex({ message: "Cannot read properties of undefined (reading 'toLowerCase')" }),
      ],
      [
        'a WebSocket outage while online',
        ex({ message: 'WebSocket connection failed: wss://prod.talyn.dev/ws' }),
      ],
      ['an empty message', ex({ message: '' })],
    ];

    it.each(KEPT)('keeps %s', (_label, exception) => {
      expect(exceptionDropReason(exception)).toBeNull();
      expect(shouldCaptureException(exception)).toBe(true);
    });
  });

  describe('rule precedence', () => {
    it('reports the hot-update reason when an offline transport failure is also a dev frame', () => {
      // Order is only observable through the reason string, but it should be
      // stable: the dev gate is the broadest statement about the event.
      const reason: DropReason | null = exceptionDropReason(
        ex({
          message: 'Failed to fetch',
          online: false,
          sources: ['/main.abc.hot-update.js'],
        })
      );
      expect(reason).toBe('dev-hot-update');
    });
  });
});

describe('shouldCaptureException', () => {
  it('is the inverse of having a drop reason', () => {
    expect(shouldCaptureException(ex({ message: 'Failed to fetch', online: false }))).toBe(false);
    expect(shouldCaptureException(ex({ message: 'Failed to fetch', online: true }))).toBe(true);
  });
});

describe('isConnectivityMessage', () => {
  it.each([
    ['Failed to fetch', true],
    ['Could not reach backend: GET /tasks — backend unreachable', true],
    ['NetworkError when attempting to fetch resource.', true],
    ['Load failed', true],
    ["Cannot read properties of undefined (reading 'toLowerCase')", false],
    ['', false],
  ])('%j → %s', (message, expected) => {
    expect(isConnectivityMessage(message)).toBe(expected);
  });
});
