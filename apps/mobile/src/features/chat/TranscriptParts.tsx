import { describeTool, type Workbench } from '@talyn/shared';
import { Link, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { AppText, Button, type Symbol } from '../../components/UI';
import { openExternal, safeExternalUrl } from '../../components/Workflow';
import { parseMarkdown, inlineText, type MdBlock, type MdInline } from '../../lib/markdown';
import { shortTime } from '../../lib/time';
import { pullRequestRoute, sessionRoute } from '../../navigation/routes';
import { mono, radius, sans, type, useTheme, withAlpha } from '../../theme/tokens';
import { MessageImages } from './AttachmentViews';
import { isImage, type MessageImage } from './attachments';
import { Markdown } from './Markdown';
import { TypingDots } from './Pulse';
import type { TranscriptRow } from './transcript';

/** Links in a message, offered to screen readers as actions on the message. */
function markdownLinks(text: string): Array<{ url: string; label: string }> {
  const links: Array<{ url: string; label: string }> = [];
  const walkInline = (nodes: MdInline[]) => {
    for (const node of nodes) {
      if (node.type === 'link') { const url = safeExternalUrl(node.href); if (url) links.push({ url, label: inlineText(node.children) || url }); }
      else if (node.type === 'strong' || node.type === 'em' || node.type === 'del') walkInline(node.children);
    }
  };
  const walk = (blocks: MdBlock[]) => {
    for (const block of blocks) {
      if (block.type === 'paragraph' || block.type === 'heading') walkInline(block.children);
      else if (block.type === 'blockquote') walk(block.children);
      else if (block.type === 'list') block.items.forEach((item) => walk(item.children));
      else if (block.type === 'table') [block.header, ...block.rows].forEach((row) => row.forEach(walkInline));
    }
  };
  walk(parseMarkdown(text).blocks);
  return links.slice(0, 10);
}

/** A message read as one unit by screen readers, with its links as actions. */
function Spoken({ label, text, style, children }: { label: string; text: string; style?: ViewStyle; children: ReactNode }) {
  const links = useMemo(() => markdownLinks(text), [text]);
  return <View accessible accessibilityLabel={label} style={style}
    accessibilityActions={links.map((link, index) => ({ name: `link-${index}`, label: `Open ${link.label}` }))}
    onAccessibilityAction={(event) => {
      const index = Number(event.nativeEvent.actionName.replace('link-', ''));
      if (links[index]) openExternal(links[index].url);
    }}>{children}</View>;
}

export const UserBubble = memo(function UserBubble({ text, timestamp, attachments, files = [], workbenchId = '', now }: { text: string; timestamp: string | null; attachments: number; files?: MessageImage[]; workbenchId?: string; now: number }) {
  const c = useTheme();
  const time = shortTime(timestamp, now);
  return <View style={styles.userWrap}>
    <Spoken label={`You said: ${text}${time ? `, ${time}` : ''}`} text={text} style={{ ...styles.bubble, backgroundColor: c.surface }}>
      <Markdown text={text} />
      {files.some(isImage) ? <MessageImages workbenchId={workbenchId} attachments={files} />
        : attachments ? <AppText variant="caption" tone="muted">{attachments === 1 ? '1 image' : `${attachments} images`}</AppText> : null}
    </Spoken>
    {time ? <AppText variant="caption" tone="muted" importantForAccessibility="no">{time}</AppText> : null}
  </View>;
});

export const AgentText = memo(function AgentText({ text, streaming }: { text: string; streaming: boolean }) {
  return <Spoken label={`Agent said: ${text}`} text={text} style={styles.flat}>
    <Markdown text={text} />
    {streaming ? <TypingDots /> : null}
  </Spoken>;
});

export function ThinkingRow({ text, compact = false }: { text: string; compact?: boolean }) {
  const c = useTheme();
  const [open, setOpen] = useState(false);
  const first = compact ? 'Thought' : text.split('\n').find((line) => line.trim())?.trim() ?? 'Thinking';
  return <View style={styles.thinking}>
    <Pressable accessibilityRole="button" accessibilityLabel={compact ? 'Thought' : 'Thinking'} accessibilityState={{ expanded: open }}
      onPress={() => setOpen(!open)} style={styles.thinkingLine} hitSlop={4}>
      <Text style={[type.meta, { color: c.muted }]}>✻</Text>
      <Text numberOfLines={open ? undefined : 1} style={[type.meta, styles.italic, { color: c.muted, flex: 1 }]}>{open && !compact ? 'Thinking' : first}</Text>
    </Pressable>
    {open ? <Text selectable style={[type.meta, styles.italic, styles.thinkingBody, { color: c.muted }]}>{text}</Text> : null}
  </View>;
}

/** A centred muted line for an event, with an icon. Tappable when it leads somewhere. */
function EventLine({ icon, text, tone = 'muted', href, url, label }: {
  icon: Symbol; text: string; tone?: 'muted' | 'destructive' | 'warning'; href?: Href; url?: string; label?: string;
}) {
  const c = useTheme();
  const color = tone === 'destructive' ? c.destructive : tone === 'warning' ? c.warning : c.muted;
  const linked = Boolean(href || url);
  const content = <View style={styles.eventInner}>
    <SymbolView name={icon} size={13} tintColor={color} />
    <Text style={[type.caption, sans(linked ? 600 : 500), { color: linked ? c.text : color, flexShrink: 1, textAlign: 'center' }]}>{text}</Text>
    {linked ? <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right' }} size={11} tintColor={c.muted} /> : null}
  </View>;
  // One plain style object: `Link asChild` drops style arrays and functions.
  const style: ViewStyle = { ...styles.event };
  if (href) return <Link href={href} asChild><Pressable accessibilityRole="link" accessibilityLabel={label ?? text} style={style}>{content}</Pressable></Link>;
  if (url) return <Pressable accessibilityRole="link" accessibilityLabel={label ?? text} onPress={() => openExternal(url)} style={style}>{content}</Pressable>;
  return <View accessible accessibilityLabel={text} style={style}>{content}</View>;
}

const PR_ICON: Symbol = { ios: 'arrow.triangle.pull', android: 'fork_right' };
const BOX_REFUSALS: Record<string, string> = {
  usage_exhausted: 'Out of hours', box_limit_reached: 'All your boxes are busy', size_requires_pro: 'This size needs Pro',
};

function SystemRow({ row, workbench }: { row: Extract<TranscriptRow, { kind: 'system' }>; workbench: Workbench }) {
  const url = row.url ? safeExternalUrl(row.url) ?? undefined : undefined;
  if (row.subtype === 'talyn_pr' && row.pullRequest) {
    const number = row.pullRequest.number;
    const verb = row.text;
    const internal = workbench.pullRequestId && (!workbench.pr || workbench.pr.number === number) ? workbench.pullRequestId : null;
    return <EventLine icon={PR_ICON} text={verb} href={internal ? pullRequestRoute(internal) : undefined} url={internal ? undefined : url}
      label={`${verb}. Open pull request`} />;
  }
  if (row.subtype === 'talyn_pr') return <EventLine icon={PR_ICON} text={row.text} url={url} tone={row.isError ? 'destructive' : 'muted'} />;
  if (row.subtype === 'talyn_memory') return <EventLine icon={{ ios: 'brain', android: 'psychology' }} text={row.text} />;
  if (row.subtype === 'talyn_thread' && row.thread) {
    const failed = row.thread.action === 'session_finished' && row.thread.status === 'error';
    return <EventLine icon={failed ? { ios: 'exclamationmark.circle', android: 'error' } : { ios: 'bubble.left.and.bubble.right', android: 'forum' }}
      text={row.text} tone={failed ? 'destructive' : 'muted'} href={sessionRoute(row.thread.sessionId)} label={`${row.text}. Open session`} />;
  }
  if (row.subtype === 'talyn_interruption') return <EventLine icon={{ ios: 'pause.circle', android: 'pause_circle' }} text="Interrupted" />;
  if (row.subtype && BOX_REFUSALS[row.subtype]) {
    return <EventLine icon={{ ios: 'pause.circle', android: 'pause_circle' }} tone="warning" text={`${BOX_REFUSALS[row.subtype]}. ${row.text}`} />;
  }
  if (row.subtype === 'talyn_message') return <EventLine icon={{ ios: 'sparkles', android: 'auto_awesome' }} text={row.text.length > 280 ? `${row.text.slice(0, 280)}…` : row.text} />;
  return <EventLine icon={{ ios: 'info.circle', android: 'info' }} text={row.text} tone={row.isError ? 'destructive' : 'muted'} url={url} />;
}

/**
 * A permission prompt, shown like web. Web has no way to answer one either:
 * sandbox runs do not stop for approval, so this records what happened.
 */
function PermissionRow({ row }: { row: Extract<TranscriptRow, { kind: 'permission' }> }) {
  const c = useTheme();
  const detail = describeTool(row.toolName, row.toolInput).detail;
  const tone = row.status === 'pending' ? c.warning : row.status === 'denied' ? c.destructive : c.success;
  const title = row.status === 'pending' ? `${row.toolName} is waiting for approval`
    : row.status === 'denied' ? `Denied ${row.toolName}` : row.status === 'auto_allowed' ? `Allowed ${row.toolName} automatically`
      : `Allowed ${row.toolName}${row.persist ? ' for this session' : ''}`;
  return <View accessible accessibilityLabel={`${title}${detail ? `. ${detail}` : ''}`}
    style={[styles.permission, { borderColor: withAlpha(tone, 0.35), backgroundColor: withAlpha(tone, c.mode === 'dark' ? 0.1 : 0.06) }]}>
    <View style={styles.eventInner}>
      <SymbolView name={{ ios: 'checkmark.shield', android: 'shield' }} size={14} tintColor={tone} />
      <Text style={[type.meta, sans(600), { color: c.text, flex: 1 }]}>{title}</Text>
    </View>
    {detail ? <Text numberOfLines={4} selectable style={[styles.mono, { color: c.muted }]}>{detail}</Text> : null}
  </View>;
}

export function PlanCard({ plan, state, busy, disabled, onApprove, onKeepPlanning }: {
  plan: string; state: 'open' | 'approved' | 'past'; busy: boolean; disabled: boolean; onApprove(): void; onKeepPlanning(): void;
}) {
  const c = useTheme();
  const open = state === 'open';
  return <View style={[styles.plan, { borderColor: open ? withAlpha(c.information, 0.5) : c.border, backgroundColor: open ? withAlpha(c.information, 0.04) : c.paper }]}>
    <View style={[styles.planHeader, { borderColor: c.border }]}>
      <SymbolView name={{ ios: 'list.bullet.clipboard', android: 'assignment' }} size={13} tintColor={c.information} />
      <AppText variant="caption" tone="muted" accessibilityRole="header" style={{ flex: 1 }}>Plan</AppText>
      {state === 'approved' ? <AppText variant="caption" tone="success">Approved</AppText> : null}
    </View>
    <View style={styles.planBody}><Markdown text={plan} /></View>
    {open ? <View style={[styles.planActions, { borderColor: c.border }]}>
      <Button size="sm" title="Approve and build" icon={{ ios: 'hammer', android: 'construction' }} loading={busy} disabled={disabled || busy} onPress={onApprove} />
      <Button size="sm" variant="secondary" title="Keep planning" disabled={busy} onPress={onKeepPlanning}
        accessibilityLabel="Keep planning. Plan mode stays on. Tell the agent what to change." />
    </View> : null}
  </View>;
}

export function FailedLine({ text }: { text: string }) {
  const c = useTheme();
  return <View accessible accessibilityRole="alert" accessibilityLabel={`Turn failed. ${text}`} style={styles.failed}>
    <SymbolView name={{ ios: 'exclamationmark.circle', android: 'error' }} size={14} tintColor={c.destructive} />
    <Text selectable style={[type.meta, { color: c.destructive, flex: 1 }]}><Text style={sans(600)}>Turn failed. </Text>{text}</Text>
  </View>;
}

export function QueuedBubble({ text, fromTalyn }: { text: string; fromTalyn: boolean }) {
  const c = useTheme();
  return <View style={styles.userWrap}>
    <View accessible accessibilityLabel={`${fromTalyn ? 'From Talyn' : 'Queued'}: ${text}`} style={[styles.bubble, styles.queued, { borderColor: c.border }]}>
      <Text numberOfLines={6} style={[type.body, { color: c.muted }]}>{text}</Text>
    </View>
    <AppText variant="caption" tone="muted" importantForAccessibility="no">{fromTalyn ? 'From Talyn' : 'Queued'}</AppText>
  </View>;
}

export { EventLine, PermissionRow, SystemRow };

const styles = StyleSheet.create({
  userWrap: { alignItems: 'flex-end', gap: 4, paddingVertical: 6 },
  bubble: { borderRadius: radius.lg, paddingHorizontal: 12, paddingVertical: 8, maxWidth: '85%' },
  queued: { borderWidth: 1, borderStyle: 'dashed' },
  flat: { paddingVertical: 6 },
  italic: { fontStyle: 'italic' },
  thinking: { paddingVertical: 3 },
  thinkingLine: { flexDirection: 'row', alignItems: 'baseline', gap: 6, minHeight: 28, paddingTop: 4 },
  thinkingBody: { marginLeft: 14 },
  event: { alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 12, maxWidth: '100%' },
  eventInner: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  permission: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: 10, gap: 6, marginVertical: 4 },
  mono: { ...mono(400), fontSize: 12, lineHeight: 18 },
  plan: { borderWidth: 1, borderRadius: radius.lg, overflow: 'hidden', marginVertical: 6 },
  planHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  planBody: { paddingHorizontal: 12, paddingVertical: 8 },
  planActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  failed: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingVertical: 6 },
});
