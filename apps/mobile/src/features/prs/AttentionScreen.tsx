import type { PRRow } from '@talyn/client/native';
import { useMemo, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { ScreenContainer } from '../../components/ScreenContainer';
import { ScreenHeader } from '../../components/ScreenHeader';
import { EmptyState, Segmented } from '../../components/UI';
import { StateNotice, workflowStyles as styles } from '../../components/Workflow';
import { useNow } from '../../lib/time';
import { useTheme } from '../../theme/tokens';
import { useResource } from '../../workflow/hooks';
import { needsAttention } from '../../workflow/model';
import { PrRow } from './PrRow';

// Phase 3 replaces these with My PRs, Review requests and Merge queue.
export type AttentionFilter = 'attention' | 'all';
const FILTERS = [{ value: 'attention', label: 'Needs attention' }, { value: 'all', label: 'All' }] as const;

export function attentionRows(rows: PRRow[], filter: AttentionFilter) {
  return rows.filter((row) => filter === 'all' || needsAttention(row)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

export function AttentionScreen() {
  const state = useResource<PRRow[]>('attention');
  const offline = useNetwork() === 'offline';
  const [filter, setFilter] = useState<AttentionFilter>('attention');
  const { workflow } = useMobileRuntime();
  const colors = useTheme();
  const now = useNow();
  const rows = useMemo(() => attentionRows(state.data ?? [], filter), [state.data, filter]);
  return <ScreenContainer topInset>
    <FlatList data={rows} keyExtractor={(item) => item.id} accessibilityRole="list" accessibilityLabel="Pull requests that need attention"
      initialNumToRender={14} maxToRenderPerBatch={10} windowSize={7} contentContainerStyle={styles.content}
      contentOffset={{ x: 0, y: workflow.local('list:attention').offset }} scrollEventThrottle={150}
      onScroll={(event) => workflow.updateLocal('list:attention', { offset: event.nativeEvent.contentOffset.y })}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={state.refreshing && state.data !== undefined} onRefresh={() => { void state.refresh(); }}
        tintColor={colors.muted} colors={[colors.primaryAction]} progressBackgroundColor={colors.elevated} />}
      ListHeaderComponent={<ScreenHeader title="Attention">
        <View style={{ gap: 8, paddingTop: 8 }}>
          <Segmented<AttentionFilter> options={FILTERS} value={filter} onChange={setFilter} accessibilityLabel="Pull request filter" />
          <StateNotice resource={state} offline={offline} refresh={state.refresh} />
        </View>
      </ScreenHeader>}
      ListEmptyComponent={state.status === 'ready' ? <EmptyState title={filter === 'all' ? 'No open pull requests' : 'You are up to date'}
        detail={filter === 'all' ? 'Open pull requests in this workspace show here.' : 'No pull requests need your action.'} /> : undefined}
      renderItem={({ item, index }) => <PrRow row={item} now={now} divider={index < rows.length - 1} />} />
  </ScreenContainer>;
}
