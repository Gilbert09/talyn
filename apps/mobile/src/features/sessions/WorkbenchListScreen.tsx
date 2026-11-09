import type { Workbench } from '@talyn/shared';
import { useMemo } from 'react';
import { FlatList, RefreshControl } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { ScreenContainer } from '../../components/ScreenContainer';
import { ScreenHeader } from '../../components/ScreenHeader';
import { EmptyState, SectionLabel } from '../../components/UI';
import { StateNotice, workflowStyles as styles } from '../../components/Workflow';
import { useNow } from '../../lib/time';
import { useTheme } from '../../theme/tokens';
import { useResource } from '../../workflow/hooks';
import { listItems } from './model';
import { WorkbenchRow } from './WorkbenchRow';

export function WorkbenchListScreen({ kind }: { kind: 'session' | 'thread' }) {
  const entity = kind === 'session' ? 'sessions' : 'threads';
  const title = kind === 'session' ? 'Sessions' : 'Threads';
  const state = useResource<Workbench[]>(entity);
  const offline = useNetwork() === 'offline';
  const { workflow } = useMobileRuntime();
  const colors = useTheme();
  const now = useNow();
  const positionKey = `list:${entity}`;
  const position = workflow.local(positionKey).offset;
  const items = useMemo(() => listItems(state.data ?? []), [state.data]);
  return <ScreenContainer topInset>
    <FlatList data={items} keyExtractor={(item) => item.key} accessibilityRole="list" accessibilityLabel={title}
      initialNumToRender={16} maxToRenderPerBatch={12} windowSize={7} contentContainerStyle={styles.content}
      contentOffset={{ x: 0, y: position }} scrollEventThrottle={150}
      onScroll={(event) => workflow.updateLocal(positionKey, { offset: event.nativeEvent.contentOffset.y })}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={state.refreshing && state.data !== undefined} onRefresh={() => { void state.refresh(); }}
        tintColor={colors.muted} colors={[colors.primaryAction]} progressBackgroundColor={colors.elevated} />}
      ListHeaderComponent={<ScreenHeader title={title}><StateNotice resource={state} offline={offline} refresh={state.refresh} /></ScreenHeader>}
      ListEmptyComponent={state.status === 'ready' ? <EmptyState title={kind === 'session' ? 'No sessions yet' : 'No threads yet'}
        detail={kind === 'session' ? 'Sessions you start in this workspace show here.' : 'Planning threads in this workspace show here.'} /> : undefined}
      renderItem={({ item }) => item.type === 'section' ? <SectionLabel title={item.repo} uppercase={false} />
        : <WorkbenchRow item={item.item} now={now} divider={!item.last} />} />
  </ScreenContainer>;
}
