import type { ClientSocket } from '@talyn/client/native';

/**
 * React Native sends `Origin: https://<api host>` when the app sets no Origin.
 * The API refuses origins it does not know and allows a missing one for native
 * clients, so the app sends an empty Origin, which the server reads as none.
 */
export const NATIVE_SOCKET_OPTIONS = { headers: { origin: '' } };

export function createNativeSocket(url: string): ClientSocket {
  return new WebSocket(url, undefined, NATIVE_SOCKET_OPTIONS) as unknown as ClientSocket;
}
