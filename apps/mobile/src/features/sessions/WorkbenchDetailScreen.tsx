import type { Workbench, WorkbenchReadiness } from '@talyn/shared';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useContext, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { ScreenContainer } from '../../components/ScreenContainer';
import { ShellLink } from '../../components/ShellScreen';
import { PrPill, SessionStateIcon } from '../../components/Status';
import { AppText, Banner, Disclosure, IconButton, Row } from '../../components/UI';
import { Heading, NativeText, StateNotice, workflowStyles as styles } from '../../components/Workflow';
import { showActionError } from '../../lib/errors';
import { useKeyboardInset } from '../../lib/keyboard';
import { workbenchState } from '../../lib/status';
import { relativeTimeLabel, useNow } from '../../lib/time';
import { completeIntent } from '../../navigation/intents';
import { pullRequestRoute, threadRoute } from '../../navigation/routes';
import { useResource } from '../../workflow/hooks';
import { workbenchKind, workbenchTitle } from '../../workflow/model';
import { Conversation } from '../chat/Conversation';
import { canRetry } from './actions';
import { readinessProblem } from './model';
import { useSessionMenu } from './SessionMenu';
import { WorkbenchRow } from './WorkbenchRow';

/** A failed start, with web's Retry. */
function FailedStart({ item }: { item: Workbench }) {
  const { workflow } = useMobileRuntime();
  const offline = useNetwork() === 'offline';
  const [busy, setBusy] = useState(false);
  const retry = () => {
    setBusy(true);
    workflow.retryWorkbench(item.id).catch((error: unknown) => showActionError('Could not retry', error)).finally(() => setBusy(false));
  };
  return <Banner tone="destructive" message={item.error ?? item.statusMessage ?? 'The session hit an error. Retry, or archive it.'}
    action={busy ? 'Retrying' : 'Retry'} onAction={retry} actionDisabled={busy || offline} />;
}

function DetailHeader({ item, readiness, compact }: { item: Workbench; readiness?: WorkbenchReadiness; compact: boolean }) {
  const now = useNow();
  const failed = canRetry(item);
  const state = workbenchState(item);
  const problem = readinessProblem(readiness, item.agent);
  const updated = relativeTimeLabel(item.updatedAt, now);
  // While typing, the title shrinks to one line so the transcript keeps its space.
  if (compact) return <View style={local.compact}>
    <SessionStateIcon state={state} />
    <AppText accessibilityRole="header" variant="rowTitle" numberOfLines={1} style={{ flex: 1 }}>{workbenchTitle(item)}</AppText>
  </View>;
  return <View style={[styles.header, local.header]}>
    <Heading size="heading">{workbenchTitle(item)}</Heading>
    <View style={local.meta}>
      <SessionStateIcon state={state} />
      <AppText variant="meta" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
        {[state.label, item.repoFullName, updated ? `Updated ${updated}` : ''].filter(Boolean).join(' · ')}
      </AppText>
    </View>
    {failed ? <FailedStart item={item} /> : item.statusMessage ? <NativeText text={item.statusMessage} /> : null}
    {problem ? <Banner message={problem} tone="warning" /> : null}
    {item.threadId || item.pullRequestId ? <View style={local.links}>
      {item.threadId ? <ShellLink href={threadRoute(item.threadId)} label="Open parent thread" /> : null}
      {item.pullRequestId ? <View style={local.prLink}>
        {item.pr ? <PrPill number={item.pr.number} state={item.pr.state} /> : null}
        <ShellLink href={pullRequestRoute(item.pullRequestId)} label="Open related pull request" />
      </View> : null}
    </View> : null}
  </View>;
}

export function WorkbenchDetailScreen({ kind }: { kind: 'session' | 'thread' }) {
  const params = useLocalSearchParams();
  const id = typeof params.id === 'string' ? params.id : '';
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const state = useResource<Workbench>('workbench', id, Boolean(id), true);
  const valid = Boolean(state.data && workbenchKind(state.data) === kind);
  const children = useResource<Workbench[]>('children', id, valid && kind === 'thread');
  const readiness = useResource<WorkbenchReadiness>('readiness', '', valid);
  const offline = useNetwork() === 'offline';
  const now = useNow();
  const item = valid ? state.data : undefined;
  const router = useRouter();
  const list = kind === 'session' ? '/sessions' as const : '/threads' as const;
  const menu = useSessionMenu({ onThreadScreen: kind === 'thread',
    onArchived: () => { if (router.canGoBack()) router.back(); else router.replace(list); } });
  useEffect(() => { if (item) completeIntent(`/${kind === 'session' ? 'sessions' : 'threads'}/${encodeURIComponent(id)}`); }, [item, kind, id]);
  const childItems = kind === 'thread' ? children.data ?? [] : [];
  const keyboard = useKeyboardInset();
  // iOS resizes through the avoiding view. An edge-to-edge Android window does not resize, so it gets the keyboard's height as padding. Android passes no behavior: a disabled padding view writes paddingBottom 0 over this style.
  const android = Platform.OS === 'android';
  return <ScreenContainer>
    {item ? <Stack.Screen options={{ headerRight: () => <IconButton label={kind === 'session' ? 'Session actions' : 'Thread actions'}
      symbol={{ ios: 'ellipsis.circle', android: 'more_vert' }} onPress={() => menu.open(item)} /> }} /> : null}
    <KeyboardAvoidingView style={[styles.page, android && { paddingBottom: keyboard.inset }]} 
      behavior={android ? undefined : 'padding'} keyboardVerticalOffset={headerHeight}>
      {item ? <Conversation key={item.id} item={item} ready={state.status === 'ready' || state.status === 'error'}
        header={<View style={local.fixed}>
          <DetailHeader item={item} readiness={readiness.data} compact={keyboard.open} />
          {state.status === 'error' || offline ? <StateNotice resource={state} offline={offline} refresh={state.refresh} /> : null}
        </View>}
        top={kind === 'thread' ? (pause) => <View style={{ gap: 4 }}>
          <StateNotice resource={children} offline={offline} refresh={children.refresh} refreshLabel="Refresh child sessions" />
          {childItems.length ? <Disclosure title={`Related sessions (${childItems.length})`} onToggle={pause}>
            <View>{childItems.map((child, index) => <WorkbenchRow key={child.id} item={child} now={now} divider={index < childItems.length - 1} />)}</View>
          </Disclosure> : children.status === 'ready' ? <AppText variant="meta" tone="muted">No sessions started from this thread yet.</AppText> : null}
        </View> : undefined} />
        : <ScrollView contentContainerStyle={[styles.content, { gap: 12 }]}>
          <StateNotice resource={state} offline={offline} refresh={state.refresh} />
          {state.data && !valid ? <Banner message="This link has the wrong work type. Return to its list." /> : null}
          {state.status === 'deleted' || state.status === 'unauthorized' || (state.data && !valid)
            ? <Row title={kind === 'session' ? 'Back to sessions' : 'Back to threads'} href={kind === 'session' ? '/sessions' : '/threads'} chevron divider={false} />
            : null}
        </ScrollView>}
    </KeyboardAvoidingView>
    {menu.elements}
  </ScreenContainer>;
}

const local = StyleSheet.create({
  fixed: { paddingHorizontal: 16, paddingTop: 8, gap: 8 },
  compact: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 4 },
  header: { gap: 6, marginBottom: 0 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  links: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 16 },
  prLink: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
