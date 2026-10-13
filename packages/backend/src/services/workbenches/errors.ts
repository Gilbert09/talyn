/**
 * A refusal the routes turn into a status and a machine code. Thrown by the
 * workbench services for conditions a person can act on — the workbench is
 * not ready, it is a local one, a path is outside the repository — and never
 * for a fault, which stays a plain Error and a 500.
 */
export class WorkbenchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'WorkbenchError';
  }
}

export const localRuntimeError = (): WorkbenchError =>
  new WorkbenchError(
    'This workbench runs on your machine; the desktop app does this itself.',
    409,
    'local_runtime',
  );

export const notReadyError = (status: string): WorkbenchError =>
  new WorkbenchError(`This workbench is ${status}, not ready.`, 409, 'not_ready');
