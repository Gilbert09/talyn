/**
 * The seam the emitters call. A leaf module on purpose: `websocket.ts` and the
 * session services import it, and importing the dispatcher itself from there
 * would pull the public API's projections into a cycle with `websocket.ts`.
 * `startApiWebhooks()` connects it to `dispatchWebhookSignal` at boot; before
 * that (and in tests that do not ask for it) a signal goes nowhere.
 */

export type WebhookSignal =
  | { kind: 'session_created'; workspaceId: string; sessionId: string }
  | {
      kind: 'session';
      workspaceId: string;
      session: { id: string; status: string; archivedAt: string | Date | null; pullRequestId: string | null };
    }
  | { kind: 'turn_started'; workspaceId: string; chatId: string; turn: number }
  | { kind: 'turn_completed'; workspaceId: string; chatId: string; turn: number; finalStatus: string }
  | {
      kind: 'pull_request';
      workspaceId: string;
      pullRequest: { id: string; state: string; lastSummary: Record<string, unknown>; codeReview?: Record<string, unknown> | null };
    }
  | { kind: 'merge_queue_blocked'; workspaceId: string; pullRequestId: string; reason: string; attempts: number };

let handler: ((signal: WebhookSignal) => void) | null = null;

export function setWebhookSignalHandler(fn: ((signal: WebhookSignal) => void) | null): void {
  handler = fn;
}

/** Hand a change to the webhook dispatcher. Never throws, never waits. */
export function sendWebhookSignal(signal: WebhookSignal): void {
  if (!handler) return;
  try {
    handler(signal);
  } catch (err) {
    console.warn('[api-webhooks] a signal failed:', err instanceof Error ? err.message : err);
  }
}
