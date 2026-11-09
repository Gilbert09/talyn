import type { WorkbenchAgent, WorkbenchReadiness } from '@talyn/shared';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useMobileRuntime } from '../../auth/AuthProvider';
import { AppText, Button, Spinner } from '../../components/UI';
import { radius, useTheme } from '../../theme/tokens';
import { useResource } from '../../workflow/hooks';
import { ConnectAgentSheet } from '../agents/connect/ConnectAgentSheet';
import { readinessRows, type ReadinessRow } from './readiness';

const FIX_LABELS = { connect: 'Connect', reauth: 'Reconnect' } as const;

/** Connect an agent in a sheet over the current screen. The store refetches what the connection changes. */
export function ConnectAgentModal({ visible, onClose, agent }: { visible: boolean; onClose(): void; agent?: WorkbenchAgent }) {
  const { workflow } = useMobileRuntime();
  const connected = () => { workflow.refresh('readiness'); workflow.refresh('providers'); };
  return <ConnectAgentSheet visible={visible} onClose={onClose} onConnected={connected} agent={agent} />;
}

function RowIcon({ row }: { row: ReadinessRow }) {
  const c = useTheme();
  if (row.state === 'loading') return <Spinner />;
  return row.state === 'ready'
    ? <SymbolView name={{ ios: 'checkmark.circle.fill', android: 'check_circle' }} size={18} tintColor={c.success} />
    : <SymbolView name={{ ios: 'circle.dashed', android: 'radio_button_unchecked' }} size={18} tintColor={c.muted} />;
}

/**
 * Whether a session can start: Sandbox, Claude Code and Codex, each with its
 * fix. Web's Welcome list, used by onboarding's last step and by home when
 * nothing is set up.
 */
export function ReadinessChecklist({ readiness: given }: { readiness?: WorkbenchReadiness }) {
  const c = useTheme();
  const resource = useResource<WorkbenchReadiness>('readiness', '', given === undefined);
  const [connecting, setConnecting] = useState<{ agent?: WorkbenchAgent } | null>(null);
  const rows = readinessRows(given ?? resource.data);
  return <View accessibilityLabel="Agents" style={[styles.list, { backgroundColor: c.paper, borderColor: c.border }]}>
    {rows.map((row, index) => <View key={row.key} accessibilityLabel={`${row.label}: ${row.detail}`}
      style={[styles.row, index < rows.length - 1 && { borderBottomColor: c.border, borderBottomWidth: StyleSheet.hairlineWidth }]}>
      <RowIcon row={row} />
      <View style={styles.text}>
        <AppText variant="rowTitle">{row.label}</AppText>
        {row.state !== 'loading' ? <AppText variant="meta" tone="muted">{row.detail}</AppText> : null}
      </View>
      {row.fix ? <Button size="sm" variant="secondary" title={FIX_LABELS[row.fix]} accessibilityLabel={`${FIX_LABELS[row.fix]} ${row.key === 'sandbox' ? 'an agent' : row.label}`}
        onPress={() => setConnecting({ agent: row.key === 'sandbox' ? undefined : row.key })} /> : null}
    </View>)}
    <ConnectAgentModal visible={connecting !== null} agent={connecting?.agent} onClose={() => setConnecting(null)} />
  </View>;
}

const styles = StyleSheet.create({
  list: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  text: { flex: 1, gap: 2 },
});
