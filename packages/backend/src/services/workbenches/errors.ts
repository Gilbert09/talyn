import {
  FleetCapacityError,
  FleetDispatchUncertainError,
  FleetHttpError,
  FleetRunNotFoundError,
  FleetThrottleError,
} from '../selfHosted/client.js';
import {
  fleetApiToken,
  fleetGatewayToken,
  FleetNotDeployedError,
  fleetPinnedEndpoint,
} from '../selfHosted/credentials.js';

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
    'This session runs on your machine; the desktop app does this itself.',
    409,
    'local_runtime',
  );

const NOT_READY_COPY: Record<string, string> = {
  provisioning: 'This session is still starting. Try again in a moment.',
  error: 'This session failed to start; retry it.',
  archived: 'This session is archived. Restore it first.',
  ready: 'This session has no sandbox yet.',
};

/** Why a workbench cannot do this now. Never shows the raw status value. */
export const notReadyError = (status: string): WorkbenchError =>
  new WorkbenchError(NOT_READY_COPY[status] ?? 'This session is not ready.', 409, 'not_ready');

/**
 * The deployment variables the fleet still needs, or null when it has what it
 * needs. Reads the environment only; it never calls the fleet. Mirrors
 * `resolveFleetTarget`: a pinned gateway needs its token, and without a gateway
 * the registry path needs `FLEET_API_TOKEN`.
 */
export function fleetDeploymentGap(): string[] | null {
  if (fleetPinnedEndpoint()) return fleetGatewayToken() ? null : ['FLEET_GATEWAY_TOKEN'];
  return fleetApiToken() ? null : ['FLEET_PINNED_ENDPOINT', 'FLEET_GATEWAY_TOKEN'];
}

/** The not-deployed message, with the variables to set. */
export function fleetNotDeployedMessage(): string {
  const missing = fleetDeploymentGap() ?? ['FLEET_PINNED_ENDPOINT', 'FLEET_GATEWAY_TOKEN'];
  return `Talyn Fleet is not configured on this backend: set ${missing.join(' and ')}.`;
}

/** A failure, in words for the person looking at the workbench. Never a private endpoint. */
export function userFacingError(err: unknown): string {
  if (err instanceof WorkbenchError) return err.message;
  if (err instanceof FleetNotDeployedError) return fleetNotDeployedMessage();
  if (err instanceof FleetCapacityError) {
    return err.reason === 'unreachable'
      ? 'The sandbox runners are not reachable right now. Try again shortly.'
      : 'The sandbox runners are all busy. Try again shortly.';
  }
  if (err instanceof FleetRunNotFoundError) return 'The sandbox no longer exists. Archive and restore this session to get a new one.';
  if (err instanceof FleetThrottleError) return 'Talyn Fleet is rate limiting requests. Try again shortly.';
  if (err instanceof FleetDispatchUncertainError) return 'Talyn Fleet did not answer in time. Try again shortly.';
  // The fleet's own error text: it names the problem and carries no endpoint.
  if (err instanceof FleetHttpError) return `Talyn Fleet refused the request: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * A fleet fault as a route answer: a status and a code. Null for an error that
 * is not the fleet's, which stays a 500.
 */
export function fleetErrorAsRefusal(err: unknown): WorkbenchError | null {
  if (err instanceof WorkbenchError) return err;
  if (err instanceof FleetNotDeployedError) return new WorkbenchError(userFacingError(err), 503, 'fleet_not_deployed');
  if (err instanceof FleetRunNotFoundError) return new WorkbenchError(userFacingError(err), 409, 'sandbox_gone');
  if (
    err instanceof FleetCapacityError ||
    err instanceof FleetThrottleError ||
    err instanceof FleetDispatchUncertainError ||
    err instanceof FleetHttpError
  ) {
    return new WorkbenchError(userFacingError(err), 503, 'fleet_unavailable');
  }
  return null;
}
