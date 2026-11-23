import { z } from 'zod';
import { MOBILE_NOTIFICATION_CATEGORIES } from '@talyn/shared';

const timezone = z.string().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; }
});
const locale = z.string().min(2).max(64).refine((value) => {
  try { return Intl.getCanonicalLocales(value).length === 1; } catch { return false; }
});
const metadata = { appVersion: z.string().min(1).max(64), locale, timezone };
export const installationInput = z.object({
  schemaVersion: z.literal(1), installationId: z.string().uuid(), workspaceId: z.string().uuid(),
  provider: z.literal('expo'), token: z.string().regex(/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$/),
  platform: z.enum(['ios', 'android']), environment: z.enum(['development', 'preview', 'production']),
  appIdentity: z.string().min(3).max(180).regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/),
  ...metadata,
}).strict();
export const heartbeatInput = z.object({ schemaVersion: z.literal(1), workspaceId: z.string().uuid(), ...metadata }).strict();
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const preferencesInput = z.object({
  schemaVersion: z.literal(1), workspaceId: z.string().uuid(), enabled: z.boolean(),
  categories: z.object(Object.fromEntries(MOBILE_NOTIFICATION_CATEGORIES.map((category) => [category, z.boolean()])) as Record<typeof MOBILE_NOTIFICATION_CATEGORIES[number], z.ZodBoolean>).strict(),
  quietHours: z.object({ enabled: z.boolean(), start: time, end: time }).strict(), timezone, sensitivePreview: z.boolean(),
  // Optional: app builds before it send no value, and the stored one is kept.
  onlyWhenAway: z.boolean().optional(),
}).strict();
export const identifierInput = z.string().uuid();
