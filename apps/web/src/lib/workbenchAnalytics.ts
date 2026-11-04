import { captureAnalyticsException } from './analytics';

export function captureWorkbenchFailure(operation: string, error: unknown, workbenchId?: string): void {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  if (typeof status === 'number' && status >= 400 && status < 500) return;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const safeError = new Error(`Workbench operation failed: ${operation}`);
  safeError.stack = undefined;
  captureAnalyticsException(safeError, {
    operation,
    workbench_id: workbenchId,
    error_code: typeof code === 'string' && code.length <= 64 && /^[a-z0-9_]+$/i.test(code) ? code : undefined,
  });
}
