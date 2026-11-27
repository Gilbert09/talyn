import type { Workbench } from '@talyn/shared';
import { useIsFocused, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import type { NavigationProp, ParamListBase } from 'expo-router/react-navigation';
import { useEffect, useState } from 'react';

import { useMobileRuntime } from '../../auth/AuthProvider';
import { DetailRoute } from '../../navigation/DetailRoute';
import { clearCreation, getCreation } from '../create/creation';
import { WorkbenchDetailScreen } from './WorkbenchDetailScreen';

type Kind = 'session' | 'thread';

export function WorkbenchRoute({ kind }: { kind: Kind }) {
  return <DetailRoute list={kind === 'session' ? '/sessions' : '/threads'}>
    <WorkbenchRouteContent kind={kind} />
  </DetailRoute>;
}

function WorkbenchRouteContent({ kind }: { kind: Kind }) {
  const { workflow } = useMobileRuntime();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [request, setRequest] = useState(() => getCreation(workflow.getScope(), id));
  const [result, setResult] = useState<Workbench | null>();
  useEffect(() => {
    if (!request) return;
    let active = true;
    void request.result.then((item) => { if (active) setResult(item); });
    return () => { active = false; };
  }, [request]);

  useEffect(() => {
    if (result?.id === id) setRequest(undefined);
  }, [id, result?.id]);

  const created = result && (id === result.id || id === request?.view.workbench.id) ? result : undefined;
  return <>
    {request && id === request.view.workbench.id && result !== undefined
      ? <ResolveCreation request={request} result={result} /> : null}
    <WorkbenchDetailScreen kind={kind} creation={id === request?.view.workbench.id && !created ? request.view : undefined} created={created} />
  </>;
}

function ResolveCreation({ request, result }: { request: NonNullable<ReturnType<typeof getCreation>>; result: Workbench | null }) {
  const router = useRouter();
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused) return;
    const state = navigation.getState();
    if (!state) return;
    const current = state.routes[state.index];
    if ((current.params as { id?: string } | undefined)?.id !== request.view.workbench.id) return;
    clearCreation(request);
    if (!result) {
      router.back();
      return;
    }
    const routes = state.routes.slice(0, state.index);
    if (request.replaceComposer && routes.at(-1)?.name === 'new') routes.pop();
    // Keep the detail route's key so the native stack keeps the same screen open.
    routes.push({ ...current, params: { ...current.params, id: result.id } });
    navigation.reset({ ...state, routes, index: routes.length - 1 });
  }, [focused, navigation, request, result, router]);

  return null;
}
