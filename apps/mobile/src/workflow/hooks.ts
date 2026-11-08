import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { useMobileRuntime } from '../auth/AuthProvider';
import type { Entity } from './model';

export function useResource<T>(entity: Entity, id = '', enabled = true, requireCurrent = false) {
  const { workflow } = useMobileRuntime();
  const scope = workflow.getScope();
  const [validated, setValidated] = useState<object | null>(null);
  const identity = useMemo(() => ({ scope, entity, id }), [scope, entity, id]);
  const state = useSyncExternalStore(workflow.subscribe, () => workflow.read<T>(entity, id));
  useEffect(() => enabled ? workflow.watch(entity, id, requireCurrent) : undefined,
    [workflow, identity, entity, id, enabled, requireCurrent]);
  useEffect(() => {
    const current = workflow.read<T>(entity, id);
    if (requireCurrent && current.status === 'ready' && !current.stale && !current.refreshing) setValidated(identity);
  }, [workflow, identity, entity, id, state, requireCurrent]);
  const hidden = requireCurrent && validated !== identity;
  return { ...state, ...(hidden ? { data: undefined, status: state.status === 'ready' ? 'loading' as const : state.status } : {}),
    refresh: () => workflow.load(entity, id) };
}
export function useLocal(id: string) {
  const { workflow } = useMobileRuntime();
  return useSyncExternalStore(workflow.subscribe, () => workflow.local(id));
}
