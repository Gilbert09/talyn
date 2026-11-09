import { editDiffFromInput, type EditDiff, type ToolBlock, type ToolGroupBlock } from '@talyn/shared';
import { SymbolView } from 'expo-symbols';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { mono, type, useTheme, withAlpha } from '../../theme/tokens';
import { ROW_TEXT_LIMIT } from '../../workflow/model';
import { StatusDot } from './Pulse';
import { ThinkingRow } from './TranscriptParts';
import { diffTone, preview, readableOutput, toolLine, type DiffTone } from './toolFormat';

const PREVIEW_LINES = 12;
const PREVIEW_CHARS = 1200;
const DIFF_PREVIEW_LINES = 12;

function Chevron({ open }: { open: boolean }) {
  const c = useTheme();
  return <SymbolView name={open ? { ios: 'chevron.down', android: 'expand_more' } : { ios: 'chevron.right', android: 'chevron_right' }} size={12} tintColor={c.muted} />;
}

/** Monospace text with diff lines tinted. Plain text when it is not a diff. */
function CodeText({ text, diff, tone }: { text: string; diff: boolean; tone?: 'error' }) {
  const c = useTheme();
  const color = tone === 'error' ? c.destructive : c.muted;
  if (!diff) return <Text selectable style={[styles.code, { color }]}>{text}</Text>;
  const tint = (kind: DiffTone) => kind === 'add' ? { color: c.success, backgroundColor: withAlpha(c.success, 0.1) }
    : kind === 'del' ? { color: c.destructive, backgroundColor: withAlpha(c.destructive, 0.1) } : kind === 'hunk' ? { color: c.information } : { color };
  return <View>{text.split('\n').map((line, index) => <Text key={index} selectable style={[styles.code, tint(diffTone(line))]}>{line || ' '}</Text>)}</View>;
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  const c = useTheme();
  return <View style={{ gap: 2 }}>
    <Text style={[type.caption, { color: c.muted }]}>{label}</Text>
    {children}
  </View>;
}

function EditDiffBody({ diff }: { diff: EditDiff }) {
  const c = useTheme();
  const [all, setAll] = useState(false);
  const lines = all ? diff.lines : diff.lines.slice(0, DIFF_PREVIEW_LINES);
  const hidden = diff.lines.length - lines.length;
  return <View style={{ gap: 4 }}>
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={[styles.diff, { backgroundColor: withAlpha(c.surface, 0.6) }]}>
        {lines.map((line, index) => line.kind === 'hunk'
          ? <Text key={index} style={[styles.code, { color: c.muted, textAlign: 'center' }]}>⋯</Text>
          : <Text key={index} selectable style={[styles.code, line.kind === 'add' ? { color: c.success, backgroundColor: withAlpha(c.success, 0.1) }
            : line.kind === 'del' ? { color: c.destructive, backgroundColor: withAlpha(c.destructive, 0.1) } : { color: c.muted }]}>
            {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '− ' : '  '}{line.text}</Text>)}
      </View>
    </ScrollView>
    {hidden > 0 ? <ShowMore label={`Show ${hidden} more ${hidden === 1 ? 'line' : 'lines'}`} onPress={() => setAll(true)} /> : null}
  </View>;
}

function ShowMore({ label, onPress }: { label: string; onPress(): void }) {
  const c = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={8} style={styles.more}>
    <Text style={[type.caption, { color: c.primaryAction }]}>{label}</Text>
  </Pressable>;
}

function inputText(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  const command = (input as { command?: unknown }).command;
  if (typeof command === 'string') return command;
  try { return JSON.stringify(input, null, 2) ?? ''; } catch { return String(input); }
}

/**
 * One tool call as a compact mono line, like web: a status dot, the verb and
 * what it acted on. Tapping opens the input and the result.
 */
export const ToolRow = memo(function ToolRow({ tool, nested = false }: { tool: ToolBlock; nested?: boolean }) {
  const c = useTheme();
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const line = useMemo(() => toolLine(tool.name, tool.input), [tool.name, tool.input]);
  const editDiff = useMemo(() => editDiffFromInput(tool.name, tool.input), [tool.name, tool.input]);
  const output = useMemo(() => open || tool.isError ? readableOutput(editDiff && !tool.isError ? undefined : tool.output) : null,
    [open, tool.isError, tool.output, editDiff]);
  const input = useMemo(() => open && !editDiff ? inputText(tool.input) : '', [open, editDiff, tool.input]);
  const state = !tool.settled ? 'running' : tool.isError ? 'error' : 'done';
  const shown = output ? full ? { text: output.text.slice(0, ROW_TEXT_LIMIT), hidden: output.text.length > ROW_TEXT_LIMIT }
    : preview(output.text, open ? PREVIEW_LINES : 3, PREVIEW_CHARS) : null;
  const label = `${line.label}${line.detail ? ` ${line.detail}` : ''}${state === 'running' ? ', running' : state === 'error' ? ', failed' : ''}`;
  return <View style={[styles.tool, nested && { paddingVertical: 2 }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open }}
      onPress={() => setOpen(!open)} style={styles.line} hitSlop={4}>
      <StatusDot state={state} />
      <Text numberOfLines={1} style={[styles.label, { color: tool.isError ? c.destructive : c.text }]}>{line.label}</Text>
      {line.detail ? <Text numberOfLines={1} style={[styles.detail, { color: c.muted }]}>{line.detail}</Text> : <View style={{ flex: 1 }} />}
      {editDiff ? <Text style={styles.counts}><Text style={{ color: c.success }}>+{editDiff.added}</Text> <Text style={{ color: c.destructive }}>−{editDiff.removed}</Text></Text> : null}
      {tool.stopped ? <Text style={[styles.counts, { color: c.muted }]}>stopped</Text> : null}
      <Chevron open={open} />
    </Pressable>
    {open || (tool.isError && shown?.text) ? <View style={[styles.body, { borderColor: tool.isError ? withAlpha(c.destructive, 0.4) : c.border }]}>
      {open && input ? <Section label="Input"><Text selectable style={[styles.code, { color: c.text }]}>{input.slice(0, PREVIEW_CHARS * 4)}</Text></Section> : null}
      {open && editDiff && editDiff.lines.length ? <EditDiffBody diff={editDiff} /> : null}
      {shown?.text ? <Section label={tool.isError ? 'Error' : `Result${output?.summary ? ` · ${output.summary}` : ''}`}>
        <CodeText text={shown.text} diff={Boolean(output?.diff)} tone={tool.isError ? 'error' : undefined} />
        {shown.hidden && !full ? <ShowMore label="Show more" onPress={() => { setOpen(true); setFull(true); }} /> : null}
      </Section> : open && !editDiff && tool.settled ? <Text style={[type.caption, { color: c.muted }]}>No output.</Text> : null}
    </View> : null}
  </View>;
});

/** A run of tool calls folded into one line, like web: "Ran 3 commands, read a file". */
export const ToolGroupRow = memo(function ToolGroupRow({ group }: { group: ToolGroupBlock }) {
  const c = useTheme();
  const [open, setOpen] = useState(group.lastFailed && !group.running);
  const state = group.running ? 'running' : group.isError ? 'error' : 'done';
  return <View style={styles.tool}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${group.summary}${group.failedCount ? `, ${group.failedCount} failed` : ''}${group.running ? ', running' : ''}`}
      accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={styles.line} hitSlop={4}>
      <StatusDot state={state} />
      <Text numberOfLines={1} style={[styles.detail, { color: c.muted }]}>
        {group.summary}{group.failedCount > 0 ? <Text style={{ color: c.destructive }}> · {group.failedCount} failed</Text> : null}
      </Text>
      <Chevron open={open} />
    </Pressable>
    {open ? <View style={[styles.group, { borderColor: c.border }]}>
      {group.children.map((child) => child.kind === 'thinking'
        ? <ThinkingRow key={child.key} text={child.text} compact />
        : <ToolRow key={child.key} tool={child} nested />)}
    </View> : null}
  </View>;
});

const styles = StyleSheet.create({
  tool: { paddingVertical: 3 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 },
  label: { ...mono(500), fontSize: 12.5, lineHeight: 18, flexShrink: 0, maxWidth: '45%' },
  detail: { ...mono(400), fontSize: 12.5, lineHeight: 18, flex: 1, minWidth: 0 },
  counts: { ...mono(400), fontSize: 11, lineHeight: 16 },
  body: { marginLeft: 2, marginTop: 4, borderLeftWidth: StyleSheet.hairlineWidth * 2, paddingLeft: 10, gap: 8 },
  group: { marginLeft: 2, marginTop: 4, borderLeftWidth: StyleSheet.hairlineWidth * 2, paddingLeft: 10, gap: 2 },
  code: { ...mono(400), fontSize: 12, lineHeight: 18 },
  diff: { borderRadius: 4, paddingVertical: 4, paddingHorizontal: 6 },
  more: { alignSelf: 'flex-start', paddingVertical: 4 },
});
