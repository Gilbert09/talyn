import type { WorkbenchChangedFile, WorkbenchDiffScope } from '@talyn/shared';
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useNetwork } from '../../auth/AuthProvider';
import { AppText, Banner, Button, Spinner } from '../../components/UI';
import { errorMessage } from '../../lib/errors';
import { mono, useTheme, withAlpha } from '../../theme/tokens';
import { clipLine, DIFF_PAGE_LINES, gutterDigits, parseUnifiedDiff, visibleDiff, type DiffLine } from './changes';
import { useFileDiff } from './data';

const LINE_HEIGHT = 18;

function Line({ line, digits }: { line: DiffLine; digits: number }) {
  const c = useTheme();
  const tint = line.kind === 'add' ? withAlpha(c.success, c.mode === 'dark' ? 0.16 : 0.1)
    : line.kind === 'del' ? withAlpha(c.destructiveFill, c.mode === 'dark' ? 0.2 : 0.1)
      : line.kind === 'hunk' ? c.paper : 'transparent';
  const color = line.kind === 'hunk' || line.kind === 'note' ? c.muted : c.text;
  const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
  const { text, cut } = clipLine(line.text);
  const gutter = { width: digits * 8 + 8, color: c.muted };
  return <View style={[styles.line, { backgroundColor: tint }]}>
    <Text style={[styles.mono, styles.gutter, gutter]}>{line.oldLine ?? ''}</Text>
    <Text style={[styles.mono, styles.gutter, gutter]}>{line.newLine ?? ''}</Text>
    <Text style={[styles.mono, styles.sign, { color: line.kind === 'add' ? c.success : line.kind === 'del' ? c.destructive : c.muted }]}>
      {line.kind === 'hunk' || line.kind === 'note' ? '' : sign}</Text>
    <Text style={[styles.mono, { color }]}>{text || ' '}{cut ? <Text style={{ color: c.muted }}>{` … ${cut.toLocaleString()} more characters`}</Text> : null}</Text>
  </View>;
}

function lineLabel(line: DiffLine): string {
  if (line.kind === 'add') return `Added line ${line.newLine}: ${line.text}`;
  if (line.kind === 'del') return `Removed line ${line.oldLine}: ${line.text}`;
  if (line.kind === 'hunk') return `Section ${line.text}`;
  return line.text;
}

/** A read-only unified diff: line numbers, tinted added and removed lines, sideways scroll for long lines. */
export function PatchView({ patch }: { patch: string }) {
  const c = useTheme();
  const lines = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const [limit, setLimit] = useState(DIFF_PAGE_LINES);
  const { shown, hidden } = visibleDiff(lines, limit);
  const digits = gutterDigits(shown);
  return <View style={{ gap: 8 }}>
    <View style={[styles.frame, { borderColor: c.border }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ minWidth: '100%' }}>
        <View accessibilityRole="list" accessibilityLabel="Diff" style={{ minWidth: '100%', paddingVertical: 4 }}>
          {shown.map((line, index) => <View key={index} accessible accessibilityLabel={lineLabel(line)}><Line line={line} digits={digits} /></View>)}
        </View>
      </ScrollView>
    </View>
    {hidden ? <View style={styles.more}>
      <AppText variant="meta" tone="muted">{`${hidden.toLocaleString()} more ${hidden === 1 ? 'line' : 'lines'}.`}</AppText>
      <Button variant="secondary" size="sm" title="Show more" onPress={() => setLimit(limit + DIFF_PAGE_LINES)} />
    </View> : null}
  </View>;
}

/** One file's diff, loaded from the session. Mirrors web `FileDiffView`, without line comments. */
export function FileDiff({ workbenchId, file, scope, revision, tooLarge }: {
  workbenchId: string; file: WorkbenchChangedFile; scope: WorkbenchDiffScope; revision: string;
  /** The stored copy has no diff because it was too large to store. */
  tooLarge: boolean;
}) {
  const [live, setLive] = useState(false);
  const offline = useNetwork() === 'offline';
  const state = useFileDiff(workbenchId, file.path, scope, live, revision);
  const data = state.data;
  if (state.status === 'error' || state.status === 'unauthorized' || state.status === 'deleted') {
    return <Banner tone="destructive" message={errorMessage(state.error, 'Could not load the diff.')}
      action="Try again" onAction={() => { void state.refresh(); }} actionDisabled={offline || state.refreshing} />;
  }
  if (state.status === 'offline' && !data) return <Banner message="You are offline. Connect to load this diff." />;
  if (data?.wake) {
    return <View style={{ gap: 8 }}>
      <AppText variant="meta" tone="muted">{tooLarge ? 'This diff is not stored (too large).' : 'This diff is not stored.'}</AppText>
      <View style={{ alignSelf: 'flex-start' }}>
        <Button variant="secondary" size="sm" title="Wake the sandbox to see it" disabled={offline} onPress={() => setLive(true)} />
      </View>
    </View>;
  }
  if (!data) {
    return <View accessibilityState={{ busy: true }} style={styles.loading}><Spinner />
      <AppText variant="meta" tone="muted">{live ? 'Waking the sandbox to load the diff' : 'Loading diff'}</AppText></View>;
  }
  const patch = data.diff?.patch ?? '';
  if (!patch.trim()) return <AppText variant="meta" tone="muted">{file.binary ? 'Binary file. No text diff.' : 'No text changes.'}</AppText>;
  return <View style={{ gap: 8 }}>
    {data.diff?.source === 'github'
      ? <AppText variant="caption" tone="muted">{`From GitHub${data.diff.mergeBase ? ` at ${data.diff.mergeBase.slice(0, 7)}` : ''}.`}</AppText> : null}
    <PatchView patch={patch} />
  </View>;
}

const styles = StyleSheet.create({
  frame: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, overflow: 'hidden' },
  line: { flexDirection: 'row', alignItems: 'flex-start', minHeight: LINE_HEIGHT, paddingRight: 12 },
  mono: { fontSize: 12, lineHeight: LINE_HEIGHT, ...mono(400) },
  gutter: { textAlign: 'right', paddingRight: 8 },
  sign: { width: 14, textAlign: 'center' },
  more: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 16 },
});
