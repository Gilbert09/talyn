import { SecureStorageError } from './storage';

export interface StartFailure { title: string; description: string }
/**
 * What the start screen says when the app cannot start. Only a locked secure store asks the person to unlock
 * the phone; every other cause used to say the same, which sent people looking for a lock that was not there.
 */
export function startFailure(error: unknown): StartFailure {
  if (error instanceof SecureStorageError) {
    return { title: 'Unlock this device', description: 'Talyn keeps your sign-in in the secure storage of this device, and it is locked. Unlock the device and try again.' };
  }
  const message = error instanceof Error && error.message ? error.message.replace(/\.$/, '') : '';
  return { title: 'Talyn could not start', description: message ? `${message}. Try again.` : 'Something stopped the app while it started. Try again.' };
}
