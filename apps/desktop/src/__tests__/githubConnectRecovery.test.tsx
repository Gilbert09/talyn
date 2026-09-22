import '@testing-library/jest-dom';
import { renderHook, waitFor } from '@testing-library/react';

/**
 * Connecting GitHub must clear EVERY "Connect GitHub" call to action, not just
 * the banner's.
 *
 * The page CTA under "My PRs" reads `pullRequests.connected`, which this hook
 * used to fetch itself, once per workspace. The banner reads the workspace
 * store's `githubStatus`, which `useSystemStatus` re-checks on focus — the one
 * signal the app gets that an App install finished in the system browser. So
 * the moment somebody connected, the banner cleared and the page CTA did not,
 * and the flow read as having failed: reported by a user who ran the whole
 * install a second time and landed back in the same place.
 *
 * Duplicated in apps/web on purpose: the renderer is a deliberate fork.
 */

type GitHubStatus = { configured: boolean; connected: boolean };

interface WorkspaceState {
  currentWorkspaceId: string | null;
  githubStatus: GitHubStatus | null;
  githubUser: { login: string } | null;
  justOnboarded: boolean;
  setJustOnboarded: (v: boolean) => void;
}

interface Recorder {
  list: number;
  forcePoll: number;
  /** Non-zero would mean the hook probes GitHub itself again. */
  status: number;
  /** Set to hold the next force-poll open, so the in-flight state is visible. */
  release: (() => void) | null;
}

// Function DECLARATIONS, and the state on globalThis: both runners hoist their
// mock factories above every import, so anything a factory touches has to
// survive being reached first.
function ws(): WorkspaceState {
  const g = globalThis as unknown as { __talynWs?: WorkspaceState };
  g.__talynWs ??= {
    currentWorkspaceId: 'ws1',
    githubStatus: null,
    githubUser: null,
    justOnboarded: false,
    setJustOnboarded: () => {},
  };
  return g.__talynWs;
}
function rec(): Recorder {
  const g = globalThis as unknown as { __talynRec?: Recorder };
  g.__talynRec ??= { list: 0, forcePoll: 0, status: 0, release: null };
  return g.__talynRec;
}

jest.mock('../renderer/lib/api', () => ({
  api: {
    pullRequests: {
      list: async () => {
        rec().list += 1;
        return [];
      },
    },
    repositories: {
      forcePoll: async () => {
        rec().forcePoll += 1;
        if (rec().release === null) return;
        await new Promise<void>((resolve) => {
          rec().release = resolve;
        });
      },
    },
    posthog: { getStatus: async () => ({ connected: false }) },
    // Present so a re-added probe is caught by the assertion below rather than
    // by an undefined-is-not-a-function crash.
    github: {
      getStatus: async () => {
        rec().status += 1;
        return { configured: true, connected: true };
      },
      getUser: async () => ({ login: 'nope' }),
    },
    ws: { on: () => () => {} },
  },
}));
jest.mock('../renderer/hooks/useOnReconnect', () => ({ useOnReconnect: () => {} }));
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: Object.assign((sel: (s: WorkspaceState) => unknown) => sel(ws()), {
    getState: () => ws(),
  }),
}));

import { usePullRequestStore } from '../renderer/stores/pullRequests';
import { usePullRequestSync } from '../renderer/hooks/usePullRequestSync';

beforeEach(() => {
  Object.assign(ws(), {
    currentWorkspaceId: 'ws1',
    githubStatus: null,
    githubUser: null,
    justOnboarded: false,
  });
  Object.assign(rec(), { list: 0, forcePoll: 0, status: 0, release: null });
  usePullRequestStore.setState({
    rows: [],
    connected: null,
    viewerLogin: null,
    initialSync: false,
    error: null,
  });
});

describe('GitHub connection state on the PR pages', () => {
  it('mirrors the workspace status instead of probing GitHub itself', () => {
    const { rerender } = renderHook(() => usePullRequestSync());
    // Not read yet: the pages draw neither the CTA nor "no PRs".
    expect(usePullRequestStore.getState().connected).toBeNull();

    ws().githubStatus = { configured: true, connected: false };
    rerender();
    expect(usePullRequestStore.getState().connected).toBe(false);

    ws().githubStatus = { configured: true, connected: true };
    ws().githubUser = { login: 'marius' };
    rerender();
    expect(usePullRequestStore.getState().connected).toBe(true);
    expect(usePullRequestStore.getState().viewerLogin).toBe('marius');

    // The whole point: one fetch, owned by useSystemStatus.
    expect(rec().status).toBe(0);
  });

  it('pulls the PRs in — and says so — when a connection lands', async () => {
    const { rerender } = renderHook(() => usePullRequestSync());
    ws().githubStatus = { configured: true, connected: false };
    rerender();
    await waitFor(() => expect(rec().list).toBeGreaterThan(0));

    // Hold the poll open: the in-flight state is the one the user sits in, and
    // the one the loader's copy is about.
    rec().release = () => {};
    ws().githubStatus = { configured: true, connected: true };
    rerender();

    // A real GitHub poll, not the cached list: a workspace that has just
    // connected has never been polled, so the cache is empty and the user
    // would land on "no pull requests" a second after authorizing.
    await waitFor(() => expect(rec().forcePoll).toBe(1));
    expect(usePullRequestStore.getState().initialSync).toBe(true);

    rec().release?.();
    await waitFor(() => expect(usePullRequestStore.getState().initialSync).toBe(false));
  });

  it('does not re-poll for a workspace that was already connected', async () => {
    ws().githubStatus = { configured: true, connected: true };
    const { rerender } = renderHook(() => usePullRequestSync());
    rerender();
    await waitFor(() => expect(rec().list).toBeGreaterThan(0));
    expect(rec().forcePoll).toBe(0);
    expect(usePullRequestStore.getState().initialSync).toBe(false);
  });

  it('leaves `connected` alone when a plain list succeeds', async () => {
    ws().githubStatus = { configured: true, connected: false };
    renderHook(() => usePullRequestSync());
    await waitFor(() => expect(rec().list).toBeGreaterThan(0));
    // Cached rows outlive a revoked installation, so a list that answers says
    // nothing about GitHub — and a second writer of this flag is what let the
    // two CTAs disagree.
    expect(usePullRequestStore.getState().connected).toBe(false);
  });
});
