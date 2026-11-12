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
/** `repository` picks the repository, for a starter aimed at one pull request. */
export const newWorkRoute = (mode: NewWorkMode, repository?: string) => ({
  pathname: '/new', params: repository ? { mode, repository } : { mode },
}) satisfies Href;
