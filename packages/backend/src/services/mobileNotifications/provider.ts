import { z } from 'zod';
import type { MobileNotificationCategory, MobileNotificationPayload, MobileProviderReceipt } from '@talyn/shared';

export type PushErrorClass = 'temporary' | 'permanent' | 'device_not_registered';
export interface PushText { title: string; body: string; }
/** `title` and `body` are the alert text (`text.ts`). Absent, the category's generic text is sent. */
export interface PushMessage { token: string; data: MobileNotificationPayload; ttlSeconds?: number; title?: string; body?: string; }
const GENERIC_PUSH_TEXT: Record<MobileNotificationCategory, PushText> = {
  session_update: { title: 'Session update', body: 'A session needs your attention.' },
  human_gate: { title: 'Needs your input', body: 'Something in Talyn is waiting for you.' },
  pr_review: { title: 'Pull request review', body: 'A pull request review changed.' },
  ci_failure: { title: 'Checks failed', body: 'Required checks failed on a pull request.' },
  merge_ready: { title: 'Ready to merge', body: 'A pull request is ready to merge.' },
};
export function genericPushText(category: MobileNotificationCategory): PushText {
  return GENERIC_PUSH_TEXT[category] ?? GENERIC_PUSH_TEXT.session_update;
}
export type PushTicket = { status: 'ok'; ticketId: string } | { status: 'error'; errorClass: PushErrorClass };
export interface MobilePushProvider {
  send(messages: readonly PushMessage[]): Promise<PushTicket[]>;
  receipts(ticketIds: readonly string[]): Promise<MobileProviderReceipt[]>;
}
export class PushProviderError extends Error {
  constructor(readonly errorClass: PushErrorClass) { super('Push provider request failed.'); }
}
const detail = z.object({ error: z.string().max(100).optional() }).passthrough().optional();
const ticket = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), id: z.string().uuid() }).passthrough(),
  z.object({ status: z.literal('error'), details: detail }).passthrough(),
]);
const receipt = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }).passthrough(),
  z.object({ status: z.literal('error'), details: detail }).passthrough(),
]);
export function providerErrorClass(value?: string): PushErrorClass {
  if (value === 'DeviceNotRegistered') return 'device_not_registered';
  if (value === 'MessageRateExceeded' || value === 'ExpoServerError') return 'temporary';
  return 'permanent';
}
export function mobileProviderAvailable(): boolean {
  return process.env.TALYN_MOBILE_PUSH_ENABLED === 'true' && !!process.env.TALYN_TOKEN_KEY &&
    !!process.env.TALYN_MOBILE_PUSH_APP_IDENTITIES;
}
export class ExpoPushProvider implements MobilePushProvider {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 10_000) {}

  private async request(path: string, body: object): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`https://exp.host/--/api/v2/push/${path}`, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json',
          ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new PushProviderError(response.status === 429 || response.status >= 500 ? 'temporary' : 'permanent');
      const reader = response.body?.getReader();
      if (!reader) throw new PushProviderError('temporary');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 1_000_000) { await reader.cancel(); throw new PushProviderError('temporary'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const raw = Buffer.concat(chunks).toString('utf8');
      try { return JSON.parse(raw); } catch { throw new PushProviderError('temporary'); }
    } catch (error) {
      if (error instanceof PushProviderError) throw error;
      throw new PushProviderError('temporary');
    } finally { clearTimeout(timer); }
  }

  async send(messages: readonly PushMessage[]): Promise<PushTicket[]> {
    if (messages.length === 0) return [];
    if (messages.length > 100) throw new PushProviderError('permanent');
    const response = z.object({ data: z.array(z.unknown()).max(100) }).safeParse(await this.request('send', messages.map((message) => {
      const generic = genericPushText(message.data.category);
      return { to: message.token, title: message.title?.trim() || generic.title, body: message.body?.trim() || generic.body,
        data: message.data, channelId: message.data.category, sound: 'default', ttl: message.ttlSeconds ?? 3600 };
    })));
    if (!response.success || response.data.data.length > messages.length) throw new PushProviderError('temporary');
    return messages.map((_message, index): PushTicket => {
      const raw = response.data.data[index];
      const checked = ticket.safeParse(raw);
      if (!checked.success) return { status: 'error', errorClass: 'temporary' };
      return checked.data.status === 'ok' ? { status: 'ok', ticketId: checked.data.id } :
        { status: 'error', errorClass: providerErrorClass(checked.data.details?.error) };
    });
  }

  async receipts(ticketIds: readonly string[]): Promise<MobileProviderReceipt[]> {
    if (ticketIds.length === 0) return [];
    if (ticketIds.length > 1000 || ticketIds.some((id) => !z.string().uuid().safeParse(id).success)) throw new PushProviderError('permanent');
    const result = z.object({ data: z.record(z.unknown()) }).safeParse(await this.request('getReceipts', { ids: ticketIds }));
    if (!result.success) throw new PushProviderError('temporary');
    return ticketIds.flatMap((ticketId): MobileProviderReceipt[] => {
      const raw = result.data.data[ticketId];
      if (raw === undefined) return [];
      const checked = receipt.safeParse(raw);
      if (!checked.success) throw new PushProviderError('temporary');
      return [{ ticketId, status: checked.data.status,
        ...(checked.data.status === 'error' ? { errorClass: providerErrorClass(checked.data.details?.error) } : {}) }];
    });
  }
}
