/**
 * Desk presence: whether a person is using Talyn on a computer right now.
 *
 * The desktop and web apps send `active` about every 30 seconds while the
 * person uses the computer, and `away` once when they stop (idle, screen lock,
 * sleep, a hidden tab). The backend keeps the signal for 60 seconds and skips a
 * mobile push while it is `active`, because the computer already shows the
 * alert. The message carries the state and nothing else.
 */
export type DeskPresenceState = 'active' | 'away';

export interface DeskPresenceMessage {
  type: 'desk_presence';
  state: DeskPresenceState;
}

/** How often an active client repeats `active`. */
export const DESK_PRESENCE_BEAT_MS = 30_000;
/** No keyboard or pointer input for this long reads as away. */
export const DESK_PRESENCE_IDLE_MS = 180_000;
/** How long the backend trusts the last `active` without a new one. */
export const DESK_PRESENCE_TTL_MS = 60_000;
