import { onWorkbenchEmit } from '../workbenches/emit.js';
import { dispatchWebhookSignal } from './dispatch.js';
import { setWebhookSignalHandler } from './signals.js';
import { webhookDeliveryWorker } from './worker.js';

/** Session emits become `session` signals. Returns the function that stops it. */
export function followSessionEmits(): () => void {
  return onWorkbenchEmit({
    workbench: (wb) =>
      dispatchWebhookSignal({
        kind: 'session',
        workspaceId: wb.workspaceId,
        session: { id: wb.id, status: wb.status, archivedAt: wb.archivedAt, pullRequestId: wb.pullRequestId },
      }),
  });
}

let unregister: (() => void) | null = null;

/**
 * Start webhooks at boot: follow session emits (the seam the Slack status
 * reactions use) and start the delivery worker. The other signals are
 * dispatched where they happen: turns in `workbenches/turns.ts`, creation in
 * `workbenches/create.ts`, pull requests and the merge queue in `websocket.ts`.
 */
export function startApiWebhooks(): void {
  setWebhookSignalHandler(dispatchWebhookSignal);
  unregister ??= followSessionEmits();
  webhookDeliveryWorker.init();
}

export function stopApiWebhooks(): void {
  unregister?.();
  unregister = null;
  setWebhookSignalHandler(null);
  webhookDeliveryWorker.stop();
}
