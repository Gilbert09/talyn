import type { PRRow } from '@talyn/client/native';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { AppText, Button, Dot, toneColor } from '../../components/UI';
import { trackEvent } from '../../lib/analytics';
import { showActionError } from '../../lib/errors';
import { pullRequestRoute } from '../../navigation/routes';
import { radius, useTheme, withAlpha } from '../../theme/tokens';
import { ReviewProgress } from '../prs/CodeReviewSection';
import type { ReviewCardView } from './codeComplete';

/**
 * The code review at the end of the chat, while the session is code complete.
 * Mirrors the web and desktop end-of-chat card.
 */
export function CodeCompleteReviewCard({ view, row, workbenchId }: { view: ReviewCardView; row: PRRow; workbenchId: string }) {
  const { workflow } = useMobileRuntime();
  const offline = useNetwork() === 'offline';
  const router = useRouter();
  const c = useTheme();
  const [busy, setBusy] = useState(false);
  const tone = toneColor(c, view.tone);
  const start = async () => {
    setBusy(true);
    try {
      // No preset: the server uses the workspace's default, as web does.
      const next = await workflow.startCodeReview(row.id);
      trackEvent('code_review_started', { preset: next.preset, depth: next.preset, source: 'session_card', workbench_id: workbenchId });
    } catch (error) {
      showActionError('Could not start the code review', error);
    } finally { setBusy(false); }
  };
  return <View testID="code-complete-review-card" style={[local.card, {
    borderColor: withAlpha(tone, 0.45), backgroundColor: withAlpha(tone, c.mode === 'dark' ? 0.08 : 0.05) }]}>
    <View style={local.head}>
      <Dot color={tone} />
      <AppText variant="rowTitle" accessibilityRole="header" accessibilityLiveRegion="polite" style={{ flex: 1 }}>{view.title}</AppText>
    </View>
    {view.state === 'running' && view.text ? <ReviewProgress fraction={view.progress} label={view.text} /> : null}
    {view.text ? <AppText variant="meta" tone={view.state === 'failed' ? 'destructive' : 'muted'}>{view.text}</AppText> : null}
    {view.findings ? <AppText variant="meta">{view.findings}</AppText> : null}
    {view.sent ? <AppText variant="meta" tone="muted">{view.sent}</AppText> : null}
    {view.start || view.viewFindings ? <View style={local.actions}>
      {view.start ? <Button size="sm" title={view.start} icon={{ ios: 'checklist', android: 'checklist' }} loading={busy}
        disabled={busy || offline} onPress={() => { void start(); }} /> : null}
      {view.viewFindings ? <Button size="sm" variant={view.start ? 'secondary' : 'primary'} title="View findings"
        onPress={() => router.push(pullRequestRoute(row.id, { tab: 'findings' }))} /> : null}
    </View> : null}
  </View>;
}

const local = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: 12, gap: 6, marginTop: 8, marginBottom: 4 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 4 },
});
