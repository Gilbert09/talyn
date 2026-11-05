import { exhaustedAgentFrom, rateLimitedAgentFrom } from '../selfHosted/exhaustedQuota.js';

/**
 * The agent could not resume its stored session, so every turn that resumes
 * it fails the same way. Only stable markers: Codex's `thread/resume` errors
 * and its "no rollout found", and Claude's "No conversation found with
 * session ID". A "not found" counts only on a line that names the session id.
 */
const RESUME_FAILURE_MARKERS: readonly RegExp[] = [
  /\bthread\/resume(?::| failed)/,
  /\bno rollout found\b/i,
  /\bNo conversation found with session ID\b/i,
];

/** A sign-in failure has its own handling. A resume error that carries one does not drop the session. */
const AUTH_FAILURE = /\b40[13]\b|unauthori[sz]ed|forbidden|invalid[ _-]?api[ _-]?key|authentication (?:failed|error|required)/i;

export function isResumeFailure(detail: string | null | undefined, sessionId: string): boolean {
  if (!detail || !sessionId) return false;
  // Rate limits and spent quotas move to another account instead.
  if (rateLimitedAgentFrom(detail) || exhaustedAgentFrom(detail)) return false;
  return detail.split('\n').some((line) => !AUTH_FAILURE.test(line) && (
    RESUME_FAILURE_MARKERS.some((marker) => marker.test(line)) ||
    (line.includes(sessionId) && /\bnot found\b/i.test(line))
  ));
}
