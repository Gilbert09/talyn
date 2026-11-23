import type { SlackChannelSummary, SlackChannelsResponse } from '@talyn/shared';
import { isSlackRateLimited, SlackApiError } from './api.js';
import { callSlackAsBot } from './tokens.js';

/**
 * The channels a team's bot is a member of, for the rule editor's channel
 * picker. A rule can watch only these: Slack sends message events only for
 * channels the bot is in.
 *
 * It asks `users.conversations`, which answers the bot's own channels only.
 * `conversations.list` answers every channel in the workspace, so a large
 * workspace took hundreds of pages, and Slack's Tier 2 limit (about 20 calls
 * a minute) refused it with a 429.
 *
 * Cached per team for a minute: the editor opens and re-renders, and a
 * minute is short enough that `/invite @Talyn` shows up on the next try.
 * When Slack rate-limits a refresh, the last good list is served again.
 */

const CACHE_TTL_MS = 60_000;
/** Slack's recommended page size. */
const PAGE_LIMIT = 200;

const cache = new Map<string, { at: number; channels: SlackChannelSummary[] }>();

export function resetSlackChannelCacheForTests(): void {
  cache.clear();
}

interface RawChannel {
  id?: unknown;
  name?: unknown;
  is_private?: unknown;
  is_archived?: unknown;
}

export async function listTeamChannels(teamId: string): Promise<SlackChannelsResponse> {
  const hit = cache.get(teamId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { channels: hit.channels };

  const channels: SlackChannelSummary[] = [];
  const seen = new Set<string>();
  let cursor = '';
  try {
    for (;;) {
      const doc = await callSlackAsBot<{ channels?: unknown; response_metadata?: { next_cursor?: unknown } }>(
        teamId,
        'users.conversations',
        {
          types: 'public_channel,private_channel',
          exclude_archived: 'true',
          limit: String(PAGE_LIMIT),
          ...(cursor ? { cursor } : {}),
        }
      );
      for (const raw of Array.isArray(doc.channels) ? (doc.channels as RawChannel[]) : []) {
        if (raw?.is_archived === true || typeof raw?.id !== 'string' || typeof raw.name !== 'string') continue;
        channels.push({ id: raw.id, name: raw.name, isPrivate: raw.is_private === true });
      }
      const next = typeof doc.response_metadata?.next_cursor === 'string' ? doc.response_metadata.next_cursor : '';
      // An empty cursor is the last page. A cursor Slack already sent would
      // loop forever, so it ends the walk too.
      if (!next || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
  } catch (err) {
    // Not cached: the answer changes the moment the app is reinstalled.
    if (err instanceof SlackApiError && err.code === 'missing_scope') {
      return { channels: [], needsScope: err.needed ?? 'channels:read,groups:read' };
    }
    if (err instanceof SlackApiError && err.code === 'no_bot_token') return { channels: [] };
    if (hit && isSlackRateLimited(err)) return { channels: hit.channels };
    throw err;
  }

  channels.sort((a, b) => a.name.localeCompare(b.name));
  cache.set(teamId, { at: Date.now(), channels });
  return { channels };
}
