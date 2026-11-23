import type { PRRow } from '@talyn/client/native';
import { sessionStarters, type SessionStarter, type SessionStarterKind } from '@talyn/shared';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useMobileRuntime } from '../../auth/AuthProvider';
import { AppText, Button, type Symbol } from '../../components/UI';
import { trackEvent } from '../../lib/analytics';
import { newWorkRoute } from '../../navigation/routes';
import { radius, type, useTheme } from '../../theme/tokens';
import { useResource } from '../../workflow/hooks';

const ICONS: Record<SessionStarterKind, Symbol> = {
  fix_checks: { ios: 'xmark.circle', android: 'cancel' },
  resolve_conflicts: { ios: 'arrow.triangle.merge', android: 'merge' },
  address_review: { ios: 'text.bubble', android: 'chat_bubble' },
  review: { ios: 'eye', android: 'visibility' },
  explain: { ios: 'book', android: 'menu_book' },
  tests: { ios: 'testtube.2', android: 'science' },
};

/** The new-work composer's draft, the same key `NewWorkScreen` reads. */
const NEW_WORK_DRAFT = 'new:prompt';

/**
 * The drawer for somebody with no sessions yet, like web's sidebar: what a
 * session is, and a few jobs to start one with. A job on a pull request starts
 * the session from that pull request.
 */
export function SessionStarters() {
  const c = useTheme();
  const router = useRouter();
  const { workflow } = useMobileRuntime();
  const rows = useResource<PRRow[]>('attention').data;
  const starters = useMemo(() => sessionStarters(rows ?? []), [rows]);

  const start = (starter: SessionStarter) => {
    trackEvent('session_starter_clicked', { kind: starter.kind, from_pull_request: starter.pr !== null });
    workflow.updateLocal(NEW_WORK_DRAFT, { draft: starter.prompt });
    router.push(newWorkRoute('session', starter.pr ? { pullRequest: starter.pr.id } : {}));
  };

  return <View style={[styles.card, { backgroundColor: c.background, borderColor: c.border }]}>
    <View style={styles.title}>
      <SymbolView name={{ ios: 'sparkles', android: 'auto_awesome' }} size={15} tintColor={c.primary} />
      <AppText variant="rowTitle">Hand work to an agent</AppText>
    </View>
    <AppText variant="meta" tone="muted">
      A session is an agent in a cloud sandbox with your repository. It fixes, reviews or builds code, and pushes the result to a branch.
    </AppText>
    <AppText variant="section" tone="muted" style={styles.try}>Try one</AppText>
    <View>
      {starters.map((starter) => <Pressable key={starter.key} accessibilityRole="button"
        accessibilityLabel={starter.detail ? `${starter.label}: ${starter.detail}` : starter.label}
        onPress={() => start(starter)} style={({ pressed }) => [styles.row, { backgroundColor: pressed ? c.surface : 'transparent' }]}>
        <SymbolView name={ICONS[starter.kind]} size={16} tintColor={c.muted} />
        <View style={styles.rowText}>
          <Text style={[type.body, { color: c.text }]}>{starter.label}</Text>
          {starter.detail ? <Text numberOfLines={1} style={[type.meta, { color: c.muted }]}>{starter.detail}</Text> : null}
        </View>
      </Pressable>)}
    </View>
    <Button title="Start a session" variant="secondary" size="sm" onPress={() => router.push(newWorkRoute('session'))} />
  </View>;
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 4, marginVertical: 6, padding: 12, gap: 6, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  title: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  try: { marginTop: 6 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, minHeight: 44, paddingVertical: 6, paddingHorizontal: 4, borderRadius: radius.md },
  rowText: { flex: 1, minWidth: 0, paddingTop: 1 },
});
