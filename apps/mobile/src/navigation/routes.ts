import type { Href } from 'expo-router';

import type { PrDetailTab } from '../features/prs/detailModel';

/** Home: the new-work composer under the navigation drawer. */
export const HOME = '/home' satisfies Href;

export const sessionRoute = (id: string) => ({
  pathname: '/sessions/[id]', params: { id },
}) satisfies Href;

export const threadRoute = (id: string) => ({
  pathname: '/threads/[id]', params: { id },
}) satisfies Href;

/** The PR screen. `tab` opens it on that tab, for example `findings`. */
export const pullRequestRoute = (id: string, options: { tab?: PrDetailTab } = {}) => ({
  pathname: '/attention/[id]', params: { id, ...(options.tab ? { tab: options.tab } : {}) },
}) satisfies Href;

export type NewWorkMode = 'session' | 'thread';
/**
 * The new-work composer. `repository` picks the repository by id or full
 * name; `pullRequest` starts the session from that open pull request, in its
 * repository; `prompt` replaces the draft.
 */
export const newWorkRoute = (mode: NewWorkMode, target: { repository?: string; pullRequest?: string; prompt?: string } = {}) => ({
  pathname: '/new', params: {
    mode,
    ...(target.repository ? { repository: target.repository } : {}),
    ...(target.pullRequest ? { pullRequest: target.pullRequest } : {}),
    ...(target.prompt ? { prompt: target.prompt } : {}),
  },
}) satisfies Href;
