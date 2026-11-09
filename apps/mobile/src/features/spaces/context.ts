import type { Space, SpaceSessionRow, SpacesTeam } from '@talyn/shared';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { useMobileRuntime, useWorkspace } from '../../auth/AuthProvider';
import { openExternal } from '../../components/Workflow';
import { useFeatures } from '../../lib/features';
import { webUrl } from '../more/Page';
import { resolveContext, type ActiveContext, type AppContext } from '../../workspaces/context';
import { useTeams } from './data';
import { openTarget, spacesOffered } from './model';

export interface ActiveContextState {
  context: ActiveContext;
  /** The active space and its team, or null in Personal and while loading. */
  active: { space: Space; team: SpacesTeam } | null;
  /** Spaces are offered to this account. False while the features load. */
  offered: boolean;
  teams: ReturnType<typeof useTeams>;
  /** Switch to my workspace or a space. Mirrors web `switchContext`. */
  select(target: AppContext): Promise<void>;
}

/**
 * Personal or a space, restored per account. `useWorkspace()` stays the
 * selected workspace in both: a space only changes what the drawer lists and
 * where new work starts.
 */
export function useActiveContext(): ActiveContextState {
  const { context: saved, workspace } = useMobileRuntime();
  const snapshot = useSyncExternalStore(saved.subscribe, saved.getSnapshot, saved.getSnapshot);
  const features = useFeatures();
  const offered = features === null ? null : spacesOffered(features);
  const teams = useTeams();
  const selected = useWorkspace().selected;
  const { context, forget } = resolveContext({ saved: snapshot, offered, teams: teams.data,
    teamsLoading: teams.data === undefined && teams.status === 'loading', workspaceId: selected });
  useEffect(() => { if (forget) void saved.select(null); }, [forget, saved]);

  const select = useCallback(async (target: AppContext) => {
    if (target.kind === 'space') { await saved.select(target.spaceId); return; }
    await saved.select(null);
    if (target.workspaceId && target.workspaceId !== workspace.getSnapshot().selected) await workspace.select(target.workspaceId);
  }, [saved, workspace]);

  return { context, active: context.kind === 'space' ? { space: context.space, team: context.team } : null,
    offered: offered === true, teams, select };
}

/** Open a space row: in the app when it is mine, switching to its workspace first, else on the web. */
export function useOpenSpaceRow() {
  const { workspace } = useMobileRuntime();
  const router = useRouter();
  return useCallback((row: Pick<SpaceSessionRow, 'id' | 'kind' | 'workspaceId'>) => {
    const snapshot = workspace.getSnapshot();
    const target = openTarget(row, snapshot.selected, snapshot.choices.map((choice) => choice.id));
    if (target.kind === 'route') router.push(target.href);
    else if (target.kind === 'switch') void workspace.select(target.workspaceId).then(() => {
      if (workspace.getSnapshot().selected === target.workspaceId) router.push(target.href);
    });
    else openExternal(webUrl(target.path));
  }, [workspace, router]);
}
