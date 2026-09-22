export interface RankingUploadEvent {
  id: string;
  event: string;
  properties: Record<string, unknown>;
}

/** Keep bounded, idempotent uploads through temporary network failures. */
export class ReviewRankingUploader {
  private events: RankingUploadEvent[] = [];
  private running = false;
  private enabled = true;
  private dropped = 0;
  private disabledSent = false;
  private key: string;

  constructor(
    workspaceId: string,
    private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    private send: (batch: { enabled: boolean; events: RankingUploadEvent[] }) => Promise<unknown>,
  ) {
    this.key = `talyn-ranking-upload-v1:${workspaceId}`;
    try {
      const pending = JSON.parse(storage.getItem(this.key) ?? '[]');
      if (Array.isArray(pending)) this.events = pending.filter((e) =>
        typeof e?.id === 'string' && typeof e?.event === 'string' &&
        e?.properties?.workspace_id === workspaceId).slice(-200);
    } catch { /* Storage can be unavailable. */ }
  }

  setEnabled(enabled: boolean): void {
    if (enabled !== this.enabled) this.disabledSent = false;
    this.enabled = enabled;
    if (!enabled) {
      this.events = [];
      try { this.storage.removeItem(this.key); } catch { /* No stored queue. */ }
    }
  }

  append(event: RankingUploadEvent): void {
    if (!this.enabled) return;
    this.events.push(event);
    while (this.events.length > 200 || JSON.stringify(this.events).length > 1_500_000) {
      this.events.shift();
      this.dropped++;
    }
    this.persist();
  }

  private persist(): void {
    try { this.storage.setItem(this.key, JSON.stringify(this.events)); } catch { /* Memory remains bounded. */ }
  }

  async flush(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const enabled = this.enabled;
    const batch = this.events.slice(0, 20);
    try {
      if ((!enabled && !this.disabledSent) || batch.length) {
        await this.send({ enabled, events: batch.map((e) => ({
          ...e, properties: { ...e.properties, upload_dropped_events: this.dropped },
        })) });
        if (!enabled) this.disabledSent = true;
        const ids = new Set(batch.map((e) => e.id));
        this.events = this.events.filter((e) => !ids.has(e.id));
        if (this.enabled) this.persist();
      }
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 400 || status === 403 || status === 413) {
        const ids = new Set(batch.map((e) => e.id));
        this.events = this.events.filter((e) => !ids.has(e.id));
        this.dropped += batch.length;
        if (this.enabled) this.persist();
      }
    } finally {
      this.running = false;
    }
  }
}
