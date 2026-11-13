import type { FleetAgent } from './index.js';

/**
 * The vendor's API failed on its side: a 5xx answer, "overloaded", or no
 * answer at all. Waiting fixes it, so a turn that ends this way is retried
 * later on a suspended box.
 *
 * Each pattern names the vendor CLI's own wording. The detector reads the
 * failed turn's last text, which can be the agent's own prose, so a bare
 * "503 Service Unavailable" (an app the agent was testing) must not match.
 */
const CLAUDE_OUTAGE = [
  /\bAPI Error:\s*5\d\d\b/i,
  /\boverloaded_error\b/i,
  /"type"\s*:\s*"api_error"/i,
  /\bAPI Error:?\s*\(?(?:Connection error|Request timed out)/i,
] as const;

const CODEX_OUTAGE = [
  /\bunexpected status 5\d\d\b/i,
  /\bexceeded retry limit,? last status:?\s*5\d\d\b/i,
  /\bstream disconnected before completion\b/i,
  /\bcurrently experiencing high demand\b/i,
] as const;

/**
 * The agent whose API failed on its side, or null for anything else. The
 * caller checks a rate limit or a spent quota first: those have their own
 * paths and their own waits.
 */
export function agentOutageFrom(detail: string | null | undefined): FleetAgent | null {
  if (typeof detail !== 'string' || !detail) return null;
  if (CODEX_OUTAGE.some((re) => re.test(detail))) return 'codex';
  if (CLAUDE_OUTAGE.some((re) => re.test(detail))) return 'claude';
  return null;
}
