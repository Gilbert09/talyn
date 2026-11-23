import { startFailure } from '../auth/startFailure';
import { SecureStorageError } from '../auth/storage';

describe('start failure copy', () => {
  it('asks to unlock the device only when secure storage is locked', () => {
    expect(startFailure(new SecureStorageError()).title).toBe('Unlock this device');
  });
  it.each([
    [new Error('Authentication setup stopped.'), 'Authentication setup stopped. Try again.'],
    [new Error('Network request failed'), 'Network request failed. Try again.'],
    ['boom', 'Something stopped the app while it started. Try again.'],
    [null, 'Something stopped the app while it started. Try again.'],
  ])('names the cause of %p', (error, description) => {
    expect(startFailure(error)).toEqual({ title: 'Talyn could not start', description });
  });
});
