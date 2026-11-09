import type { ClientSocket } from '@talyn/client/native';

/**
 * React Native sends `Origin: https://<api host>` when the app sets no Origin.
 * The API refuses origins it does not know and allows a missing one for native
 * clients, so the app sends an empty Origin, which the server reads as none.
 */
export const NATIVE_SOCKET_OPTIONS = { headers: { origin: '' } };

// React Native's constructor takes a third options argument that the DOM type leaves out.
type NativeWebSocket = new (url: string, protocols: string | string[] | undefined, options: typeof NATIVE_SOCKET_OPTIONS) => unknown;

export function createNativeSocket(url: string): ClientSocket {
  const Socket = WebSocket as unknown as NativeWebSocket;
  return new Socket(url, undefined, NATIVE_SOCKET_OPTIONS) as ClientSocket;
}
