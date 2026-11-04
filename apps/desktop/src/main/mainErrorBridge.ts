export interface MainErrorFrame {
  source: 'main' | 'renderer';
  operation: string;
  reason?: string;
  exitCode?: number;
  errorCode?: string;
}

let send: ((frame: MainErrorFrame) => boolean) | null = null;
let rendererReady = false;
const pending: MainErrorFrame[] = [];

export function setMainErrorSender(sender: (frame: MainErrorFrame) => boolean): void {
  send = sender;
}

export function markRendererUnavailable(): void {
  rendererReady = false;
}

export function drainMainErrors(): MainErrorFrame[] {
  rendererReady = true;
  return pending.splice(0);
}

export function reportMainFailure(operation: string, error?: unknown, extra: Partial<MainErrorFrame> = {}): void {
  const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const frame: MainErrorFrame = {
    source: extra.source ?? 'main',
    operation,
    reason: extra.reason,
    exitCode: extra.exitCode,
    errorCode: typeof rawCode === 'string' && rawCode.length <= 64 && /^[a-z0-9_]+$/i.test(rawCode) ? rawCode : undefined,
  };
  if (rendererReady && send?.(frame)) return;
  rendererReady = false;
  pending.push(frame);
  if (pending.length > 20) pending.shift();
}
