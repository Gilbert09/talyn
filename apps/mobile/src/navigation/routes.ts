import type { Href } from 'expo-router';

/** Home: the new-work composer under the navigation drawer. */
export const HOME = '/home' satisfies Href;

export const sessionRoute = (id: string) => ({
  pathname: '/sessions/[id]', params: { id },
}) satisfies Href;

export const threadRoute = (id: string) => ({
  pathname: '/threads/[id]', params: { id },
}) satisfies Href;

export const pullRequestRoute = (id: string) => ({
  pathname: '/attention/[id]', params: { id },
}) satisfies Href;

export type NewWorkMode = 'session' | 'thread';
/**
 * The new-work composer. `repository` picks the repository; `pullRequest`
 * starts the session from that open pull request, in its repository.
 */
export const newWorkRoute = (mode: NewWorkMode, target: { repository?: string; pullRequest?: string } = {}) => ({
  pathname: '/new', params: {
    mode,
    ...(target.repository ? { repository: target.repository } : {}),
    ...(target.pullRequest ? { pullRequest: target.pullRequest } : {}),
  },
}) satisfies Href;
