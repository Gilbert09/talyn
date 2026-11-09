import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { useMobileRuntime } from '../auth/AuthProvider';
import type { Entity } from './model';

/**
 * Read one store entry and keep it fresh while mounted.
 *
 * `requireCurrent` hides cached content until one fetch that started after the
 * screen opened has succeeded, which re-checks authorization for deep links.
 * After that the screen keeps its data through later background refetches.
 */
export function useResource<T>(entity: Entity, id = '', enabled = true, requireCurrent = false) {
  const { workflow } = useMobileRuntime();
  const scope = workflow.getScope();
  const identity = useMemo(() => ({ scope, entity, id }), [scope, entity, id]);
  const since = useMemo(() => ({ identity, loads: workflow.loadCount() }), [workflow, identity]);
  const [validated, setValidated] = useState<object | null>(null);
  const state = useSyncExternalStore(workflow.subscribe, () => workflow.read<T>(entity, id));
  useEffect(() => enabled ? workflow.watch(entity, id, requireCurrent) : undefined,
    [workflow, identity, entity, id, enabled, requireCurrent]);
  const current = state.status === 'ready' && (state.version ?? 0) > since.loads;
  useEffect(() => { if (requireCurrent && current) setValidated(identity); }, [requireCurrent, current, identity]);
  const hidden = requireCurrent && validated !== identity && !current;
  return { ...state, ...(hidden ? { data: undefined, status: state.status === 'ready' ? 'loading' as const : state.status } : {}),
    refresh: () => workflow.load(entity, id) };
}
export function useLocal(id: string) {
  const { workflow } = useMobileRuntime();
  return useSyncExternalStore(workflow.subscribe, () => workflow.local(id));
}
