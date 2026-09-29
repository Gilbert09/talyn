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
  private discardedSnapshots = new Set<string>();
  private generation = 0;
  private disabledSent = false;
  private key: string;

  constructor(
    workspaceId: string,
    private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    private send: (batch: { enabled: boolean; events: RankingUploadEvent[] }) => Promise<unknown>,
  ) {
    this.key = `talyn-ranking-upload-v1:${workspaceId}`;
    try {
      const saved = JSON.parse(storage.getItem(this.key) ?? '[]');
      const pending = Array.isArray(saved) ? saved : saved?.events;
      if (Number.isSafeInteger(saved?.dropped) && saved.dropped >= 0) this.dropped = saved.dropped;
      if (Array.isArray(saved?.discardedSnapshots)) {
        this.discardedSnapshots = new Set(saved.discardedSnapshots.filter((id: unknown) => typeof id === 'string').slice(-200));
      }
      if (Array.isArray(pending)) this.events = pending.filter((e) =>
        typeof e?.id === 'string' && typeof e?.event === 'string' &&
        e?.properties?.workspace_id === workspaceId);
      this.trim();
    } catch { /* Storage can be unavailable. */ }
  }

  setEnabled(enabled: boolean): void {
    if (enabled !== this.enabled) this.disabledSent = false;
    if (enabled !== this.enabled) this.generation++;
    this.enabled = enabled;
    if (!enabled) {
      this.events = [];
      this.discardedSnapshots.clear();
      this.dropped = 0;
      try { this.storage.removeItem(this.key); } catch { /* No stored queue. */ }
    }
  }

  append(event: RankingUploadEvent): void {
    if (!this.enabled) return;
    if (this.discardedSnapshots.has(String(event.properties.snapshot_id))) {
      this.dropped++;
      this.persist();
      return;
    }
    this.events.push(event);
    this.trim();
    this.persist();
  }

  private discard(event: RankingUploadEvent): void {
    const snapshot = event.properties.snapshot_id;
    if (typeof snapshot === 'string') {
      this.discardedSnapshots.add(snapshot);
      while (this.discardedSnapshots.size > 200) {
        this.discardedSnapshots.delete(this.discardedSnapshots.values().next().value!);
      }
    }
    const before = this.events.length;
    this.events = this.events.filter((e) => typeof snapshot === 'string'
      ? e.properties.snapshot_id !== snapshot : e.id !== event.id);
    this.dropped += before - this.events.length;
  }

  private trim(): void {
    while (this.events.length > 200 || JSON.stringify(this.events).length > 1_500_000) {
      this.discard(this.events[0]);
    }
  }

  private persist(): void {
    try {
      this.storage.setItem(this.key, JSON.stringify({
        events: this.events, dropped: this.dropped, discardedSnapshots: [...this.discardedSnapshots],
      }));
    } catch { /* Memory remains bounded. */ }
  }

  private async sendBatch(batch: RankingUploadEvent[], generation: number): Promise<void> {
    if (!this.enabled || this.generation !== generation) return;
    const pending = new Set(this.events.map((e) => e.id));
    batch = batch.filter((e) => pending.has(e.id));
    if (!batch.length) return;
    try {
      await this.send({ enabled: true, events: batch.map((e) => ({
        ...e, properties: { ...e.properties, upload_dropped_events: this.dropped },
      })) });
      if (this.generation !== generation) return;
      const ids = new Set(batch.map((e) => e.id));
      this.events = this.events.filter((e) => !ids.has(e.id));
      this.persist();
    } catch (error) {
      if (this.generation !== generation) return;
      const status = (error as { status?: number }).status;
      if ((status === 400 || status === 413) && batch.length > 1) {
        // Isolate a rejected record without losing unrelated snapshots.
        const middle = Math.ceil(batch.length / 2);
        await this.sendBatch(batch.slice(0, middle), generation);
        await this.sendBatch(batch.slice(middle), generation);
      } else if (status === 400 || status === 403 || status === 413) {
        for (const event of batch) this.discard(event);
        this.persist();
        if (status === 403) throw error;
      } else {
        throw error;
      }
    }
  }

  async flush(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const generation = this.generation;
    try {
      if (!this.enabled && !this.disabledSent) {
        await this.send({ enabled: false, events: [] });
        if (generation === this.generation) this.disabledSent = true;
        return;
      }
      // Drain the bounded queue in this flush, rather than one batch per timer.
      let remaining = this.events.length;
      while (this.enabled && generation === this.generation && this.events.length && remaining > 0) {
        const batch = this.events.slice(0, Math.min(20, remaining));
        await this.sendBatch(batch, generation);
        remaining -= batch.length;
      }
    } catch {
      // A transient failure retains stable event IDs for the next flush.
    } finally {
      this.running = false;
    }
  }
}
