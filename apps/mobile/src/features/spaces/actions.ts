import { spaces } from '@talyn/client/native';
import type { SpacesTeam, Workbench } from '@talyn/shared';
import { useCallback } from 'react';

import { useNetwork, useWorkspace } from '../../auth/AuthProvider';
import type { SheetRequest, Symbol } from '../../components/UI';
import { showActionError } from '../../lib/errors';
import { useFeatures } from '../../lib/features';
import { useTeams } from './data';
import { canMoveToSpace, moveChoices, spacesOffered } from './model';

export const MOVE_TO_SPACE_ICON: Symbol = { ios: 'square.grid.2x2', android: 'workspaces' };

export interface MoveToSpaceContext {
  /** Spaces is offered to the account (the `spaces` flag). */
  offered: boolean;
  /** My teams, or null while they load. */
  teams: readonly SpacesTeam[] | null | undefined;
  /** The selected workspace. Only its items are mine to move. */
  workspaceId: string | null;
  offline?: boolean;
  /** Opens the space picker. Pass the `open` of the menu's `useActionSheet()`. */
  openSheet(request: SheetRequest): void;
  /** Called with the moved session or thread, after the server answered. */
  onMoved?(workbench: Workbench): void;
}

export interface MoveToSpaceAction { label: string; icon: Symbol; disabled: boolean; detail?: string; run(): void }

/**
 * The "Move to space…" menu entry for a session or thread, or null when it is
 * not offered (Spaces off, teams not loaded, archived, or not mine). `run`
 * opens a picker of Personal and every space, and moves the item with the
 * same call web uses. The item still runs on its owner's account.
 */
export function moveToSpaceAction(workbench: Workbench, context: MoveToSpaceContext): MoveToSpaceAction | null {
  if (!canMoveToSpace(workbench, context)) return null;
  const current = workbench.spaceId ?? null;
  const noun = workbench.kind === 'thread' ? 'thread' : 'session';
  const move = async (to: string | null) => {
    try {
      const moved = await spaces.moveSession(workbench.id, to);
      context.onMoved?.(moved);
    } catch (error) {
      showActionError('Could not move it', error);
    }
  };
  return {
    label: 'Move to space…', icon: MOVE_TO_SPACE_ICON,
    disabled: Boolean(context.offline), detail: context.offline ? 'You are offline.' : undefined,
    run: () => context.openSheet({
      title: workbench.kind === 'thread' ? 'Move thread' : 'Move session',
      message: `In a space, your teammates can see this ${noun}. It still runs on your account.`,
      actions: moveChoices(context.teams ?? [], current).map((choice) => ({
        label: choice.label, detail: choice.team ?? undefined, selected: choice.selected,
        icon: choice.spaceId ? MOVE_TO_SPACE_ICON : { ios: 'person', android: 'person' },
        onPress: () => { if (!choice.selected) void move(choice.spaceId); },
      })),
    }),
  };
}

/**
 * The hook form for a menu: loads my teams when Spaces is offered and answers
 * `moveToSpaceAction` for a workbench with the menu's own sheet.
 */
export function useMoveToSpace(openSheet: (request: SheetRequest) => void, onMoved?: (workbench: Workbench) => void) {
  const offered = spacesOffered(useFeatures());
  const teams = useTeams();
  const workspaceId = useWorkspace().selected;
  const offline = useNetwork() === 'offline';
  const data = teams.data;
  return useCallback((workbench: Workbench) => moveToSpaceAction(workbench, {
    offered, teams: data ?? null, workspaceId, offline, openSheet, onMoved,
  }), [offered, data, workspaceId, offline, openSheet, onMoved]);
}
