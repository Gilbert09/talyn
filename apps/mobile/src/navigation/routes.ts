import type { Href } from 'expo-router';

export const sessionRoute = (id: string) => ({
  pathname: '/sessions/[id]', params: { id },
}) satisfies Href;

export const threadRoute = (id: string) => ({
  pathname: '/threads/[id]', params: { id },
}) satisfies Href;

export const pullRequestRoute = (id: string) => ({
  pathname: '/attention/[id]', params: { id },
}) satisfies Href;
