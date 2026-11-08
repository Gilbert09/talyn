import type { AuthController } from './controller';

export type DeletionResult = 'deleted' | 'blocked' | 'failed';

export class AccountActions {
  private deletion: Promise<DeletionResult> | null = null;
  constructor(private auth: AuthController, private wipe: () => Promise<void>) {}
  deleteAccount = (): Promise<DeletionResult> => {
    if (this.deletion) return this.deletion;
    const user = this.auth.getSnapshot().user?.id;
    if (!user) return Promise.resolve('failed');
    this.deletion = (async (): Promise<DeletionResult> => {
      try {
        await this.wipe();
        if (this.auth.getSnapshot().user?.id !== user) return 'failed';
        await this.auth.signOut();
        if (this.auth.getSnapshot().status !== 'signedOut') return 'failed';
        this.auth.markAccountDeleted();
        return 'deleted';
      } catch (error) {
        // This endpoint uses 409 only for the last administrator of a paying team.
        return (error as { status?: number } | null)?.status === 409 ? 'blocked' : 'failed';
      }
    })().finally(() => { this.deletion = null; });
    return this.deletion;
  };
}
