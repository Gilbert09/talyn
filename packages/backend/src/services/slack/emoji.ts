import type { SlackCustomEmoji, SlackEmojiResponse } from '@talyn/shared';
import { callSlack, SlackApiError } from './api.js';
import { getSlackBotToken } from './tokens.js';

/**
 * A team's custom emoji for the trigger picker, from Slack's `emoji.list`
 * with the bot token. Cached per team in memory: the list is large, changes
 * rarely, and a settings page opening twice should not call Slack twice.
 */

const CACHE_TTL_MS = 10 * 60_000;
const MAX_ALIAS_HOPS = 5;

const cache = new Map<string, { at: number; emoji: SlackCustomEmoji[] }>();

export function resetSlackEmojiCacheForTests(): void {
  cache.clear();
}

/**
 * Turn Slack's `name → url | "alias:other"` map into a name/url list. An alias
 * takes its target's image. An alias of a standard emoji has no image and is
 * dropped: the standard picker already offers that emoji.
 */
export function resolveCustomEmoji(raw: Record<string, unknown>): SlackCustomEmoji[] {
  const out: SlackCustomEmoji[] = [];
  for (const name of Object.keys(raw)) {
    let value = raw[name];
    for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
      if (typeof value === 'string' && value.startsWith('alias:')) value = raw[value.slice(6)];
      else break;
    }
    if (typeof value === 'string' && /^https?:\/\//.test(value)) out.push({ name, url: value });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listTeamEmoji(teamId: string): Promise<SlackEmojiResponse> {
  const hit = cache.get(teamId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { emoji: hit.emoji };

  const token = await getSlackBotToken(teamId);
  if (!token) return { emoji: [] };
  try {
    const doc = await callSlack<{ emoji?: Record<string, unknown> }>('emoji.list', { token });
    const emoji = resolveCustomEmoji(doc.emoji ?? {});
    cache.set(teamId, { at: Date.now(), emoji });
    return { emoji };
  } catch (err) {
    // Not cached: the answer changes the moment the app is reinstalled.
    if (err instanceof SlackApiError && err.code === 'missing_scope') {
      return { emoji: [], needsScope: 'emoji:read' };
    }
    throw err;
  }
}
