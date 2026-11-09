import type { Workbench, WorkbenchReadiness } from '@talyn/shared';
import { useLocalSearchParams } from 'expo-router';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useContext, useEffect } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';

import { useNetwork } from '../../auth/AuthProvider';
import { ScreenContainer } from '../../components/ScreenContainer';
import { ShellLink } from '../../components/ShellScreen';
import { PrPill, SessionStateIcon } from '../../components/Status';
import { AppText, Banner, Disclosure, Row } from '../../components/UI';
import { Heading, NativeText, StateNotice, workflowStyles as styles } from '../../components/Workflow';
import { workbenchState } from '../../lib/status';
import { relativeTimeLabel, useNow } from '../../lib/time';
import { completeIntent } from '../../navigation/intents';
import { pullRequestRoute, threadRoute } from '../../navigation/routes';
import { useResource } from '../../workflow/hooks';
import { workbenchKind, workbenchTitle } from '../../workflow/model';
import { Conversation } from '../chat/Conversation';
import { readinessProblem } from './model';
import { WorkbenchRow } from './WorkbenchRow';

function DetailHeader({ item, readiness }: { item: Workbench; readiness?: WorkbenchReadiness }) {
  const now = useNow();
  const state = workbenchState(item);
  const problem = readinessProblem(readiness, item.agent);
  const updated = relativeTimeLabel(item.updatedAt, now);
  return <View style={[styles.header, local.header]}>
    <Heading size="heading">{workbenchTitle(item)}</Heading>
    <View style={local.meta}>
      <SessionStateIcon state={state} />
      <AppText variant="meta" tone="muted" numberOfLines={1} style={{ flexShrink: 1 }}>
        {[state.label, item.repoFullName, updated ? `Updated ${updated}` : ''].filter(Boolean).join(' · ')}
      </AppText>
    </View>
    {item.statusMessage ? <NativeText text={item.statusMessage} /> : null}
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
  useEffect(() => { if (item) completeIntent(`/${kind === 'session' ? 'sessions' : 'threads'}/${encodeURIComponent(id)}`); }, [item, kind, id]);
  const childItems = kind === 'thread' ? children.data ?? [] : [];
  return <ScreenContainer>
    <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}>
      {item ? <Conversation key={item.id} item={item} ready={state.status === 'ready' || state.status === 'error'}
        header={<View style={local.fixed}>
          <DetailHeader item={item} readiness={readiness.data} />
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
  </ScreenContainer>;
}

const local = StyleSheet.create({
  fixed: { paddingHorizontal: 16, paddingTop: 8, gap: 8 },
  header: { gap: 6, marginBottom: 0 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  links: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 16 },
  prLink: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
