import {
  describeTool, endQuotesAtPlainLines, formatQuestionAnswers, isQuestionAnswered, type QuestionAnswer, type Workbench, type WorkbenchMessageSender,
  type WorkbenchQuestionEvent, type WorkbenchQuestionItem,
} from '@talyn/shared';
import { Link, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { memo, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { AppText, Button, IconButton, Input, type Symbol } from '../../components/UI';
import { openExternal, safeExternalUrl } from '../../components/Workflow';
import { parseMarkdown, inlineText, type MdBlock, type MdInline } from '../../lib/markdown';
import { shortTime } from '../../lib/time';
import { pullRequestRoute, sessionRoute } from '../../navigation/routes';
import { mono, radius, sans, type, useTheme, withAlpha } from '../../theme/tokens';
import { MessageImages } from './AttachmentViews';
import type { MessageImage } from './attachments';
import { Markdown } from './Markdown';
import { TypingDots } from './Pulse';
import { answeredLabel, senderLabel, type TranscriptRow } from './transcript';
import { useHighlighter } from './findHighlight';
import { useMessageMenuOpener } from './messageMenu';
import { BOX_REFUSALS, permissionTitle, systemRowText } from './transcriptFind';

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
      else if (block.type === 'image') links.push({ url: block.src, label: `image: ${block.alt || 'Image'}` });
    }
  };
  walk(parseMarkdown(text).blocks);
  return links.slice(0, 10);
}

/**
 * A message read as one unit by screen readers, with its links as actions.
 * In a conversation a long press opens the message menu; the text is then
 * not natively selectable, so the two long presses do not fight.
 */
function Spoken({ label, text, style, children }: { label: string; text: string; style?: ViewStyle; children(selectable: boolean): ReactNode }) {
  const links = useMemo(() => markdownLinks(text), [text]);
  const openMenu = useMessageMenuOpener();
  const actions = [
    ...links.map((link, index) => ({ name: `link-${index}`, label: `Open ${link.label}` })),
    ...(openMenu ? [{ name: 'longpress', label: 'Message actions' }] : []),
  ];
  const onAction = (name: string) => {
    if (name === 'longpress') { openMenu?.(text); return; }
    const index = Number(name.replace('link-', ''));
    if (links[index]) openExternal(links[index].url);
  };
  if (!openMenu) return <View accessible accessibilityLabel={label} style={style} accessibilityActions={actions}
    onAccessibilityAction={(event) => onAction(event.nativeEvent.actionName)}>{children(true)}</View>;
  return <Pressable accessible accessibilityLabel={label} accessibilityHint="Long press for message actions." style={style}
    accessibilityActions={actions} onAccessibilityAction={(event) => onAction(event.nativeEvent.actionName)}
    onLongPress={() => openMenu(text)}>{children(false)}</Pressable>;
}

export const UserBubble = memo(function UserBubble({ text, timestamp, attachments, files = [], workbenchId = '', now, sender }: {
  text: string; timestamp: string | null; attachments: number; files?: MessageImage[]; workbenchId?: string; now: number;
  /** The thread that wrote the message. */
  sender?: WorkbenchMessageSender;
}) {
  const c = useTheme();
  const time = shortTime(timestamp, now);
  return <View style={styles.userWrap}>
    {sender ? <AppText variant="caption" tone="muted" importantForAccessibility="no">{senderLabel(sender)}</AppText> : null}
    <Spoken label={`${sender ? senderLabel(sender) : 'You said'}: ${text}${time ? `, ${time}` : ''}`} text={text} style={{ ...styles.bubble, backgroundColor: c.surface }}>
      {(selectable) => <>
        <Markdown text={endQuotesAtPlainLines(text)} selectable={selectable} />
        {files.length ? <MessageImages workbenchId={workbenchId} attachments={files} />
          : attachments ? <AppText variant="caption" tone="muted">{attachments === 1 ? '1 attachment' : `${attachments} attachments`}</AppText> : null}
      </>}
    </Spoken>
    {time ? <AppText variant="caption" tone="muted" importantForAccessibility="no">{time}</AppText> : null}
  </View>;
});

export const AgentText = memo(function AgentText({ text, streaming }: { text: string; streaming: boolean }) {
  return <Spoken label={`Agent said: ${text}`} text={text} style={styles.flat}>
    {(selectable) => <>
      <Markdown text={text} selectable={selectable} />
      {streaming ? <TypingDots /> : null}
    </>}
  </Spoken>;
});

export function ThinkingRow({ text, compact = false }: { text: string; compact?: boolean }) {
  const c = useTheme();
  const mark = useHighlighter();
  const [open, setOpen] = useState(false);
  const first = compact ? 'Thought' : text.split('\n').find((line) => line.trim())?.trim() ?? 'Thinking';
  return <View style={styles.thinking}>
    <Pressable accessibilityRole="button" accessibilityLabel={compact ? 'Thought' : 'Thinking'} accessibilityState={{ expanded: open }}
      onPress={() => setOpen(!open)} style={styles.thinkingLine} hitSlop={4}>
      <Text style={[type.meta, { color: c.muted }]}>✻</Text>
      <Text numberOfLines={open ? undefined : 1} style={[type.meta, styles.italic, { color: c.muted, flex: 1 }]}>{open && !compact ? 'Thinking' : mark(first)}</Text>
    </Pressable>
    {open ? <Text selectable style={[type.meta, styles.italic, styles.thinkingBody, { color: c.muted }]}>{text}</Text> : null}
  </View>;
}

/** A centred muted line for an event, with an icon. Tappable when it leads somewhere. */
function EventLine({ icon, text, tone = 'muted', href, url, label }: {
  icon: Symbol; text: string; tone?: 'muted' | 'destructive' | 'warning'; href?: Href; url?: string; label?: string;
}) {
  const c = useTheme();
  const mark = useHighlighter();
  const color = tone === 'destructive' ? c.destructive : tone === 'warning' ? c.warning : c.muted;
  const linked = Boolean(href || url);
  const content = <View style={styles.eventInner}>
    <SymbolView name={icon} size={13} tintColor={color} />
    <Text style={[type.caption, sans(linked ? 600 : 500), { color: linked ? c.text : color, flexShrink: 1, textAlign: 'center' }]}>{mark(text)}</Text>
    {linked ? <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right' }} size={11} tintColor={c.muted} /> : null}
  </View>;
  // One plain style object: `Link asChild` drops style arrays and functions.
  const style: ViewStyle = { ...styles.event };
  if (href) return <Link href={href} asChild><Pressable accessibilityRole="link" accessibilityLabel={label ?? text} style={style}>{content}</Pressable></Link>;
  if (url) return <Pressable accessibilityRole="link" accessibilityLabel={label ?? text} onPress={() => openExternal(url)} style={style}>{content}</Pressable>;
  return <View accessible accessibilityLabel={text} style={style}>{content}</View>;
}

const PR_ICON: Symbol = { ios: 'arrow.triangle.pull', android: 'fork_right' };
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
  if (row.subtype === 'talyn_interruption') return <EventLine icon={{ ios: 'pause.circle', android: 'pause_circle' }} text={systemRowText(row)} />;
  if (row.subtype && BOX_REFUSALS[row.subtype]) {
    return <EventLine icon={{ ios: 'pause.circle', android: 'pause_circle' }} tone="warning" text={systemRowText(row)} />;
  }
  if (row.subtype === 'talyn_message') return <EventLine icon={{ ios: 'sparkles', android: 'auto_awesome' }} text={systemRowText(row)} />;
  return <EventLine icon={{ ios: 'info.circle', android: 'info' }} text={row.text} tone={row.isError ? 'destructive' : 'muted'} url={url} />;
}

/**
 * A permission prompt, shown like web. Web has no way to answer one either:
 * sandbox runs do not stop for approval, so this records what happened.
 */
function PermissionRow({ row }: { row: Extract<TranscriptRow, { kind: 'permission' }> }) {
  const c = useTheme();
  const mark = useHighlighter();
  const detail = describeTool(row.toolName, row.toolInput).detail;
  const tone = row.status === 'pending' ? c.warning : row.status === 'denied' ? c.destructive : c.success;
  const title = permissionTitle(row);
  return <View accessible accessibilityLabel={`${title}${detail ? `. ${detail}` : ''}`}
    style={[styles.permission, { borderColor: withAlpha(tone, 0.35), backgroundColor: withAlpha(tone, c.mode === 'dark' ? 0.1 : 0.06) }]}>
    <View style={styles.eventInner}>
      <SymbolView name={{ ios: 'checkmark.shield', android: 'shield' }} size={14} tintColor={tone} />
      <Text style={[type.meta, sans(600), { color: c.text, flex: 1 }]}>{mark(title)}</Text>
    </View>
    {detail ? <Text numberOfLines={4} selectable style={[styles.mono, { color: c.muted }]}>{mark(detail)}</Text> : null}
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

/** One question, one single-select list of options: a tap on an option sends it. */
function sendsOnPick(question: WorkbenchQuestionEvent): boolean {
  const only = question.questions.length === 1 ? question.questions[0] : null;
  return Boolean(only && !only.multiSelect && only.options.length > 0);
}

/**
 * The agent's question. `open` with `waiting` off: the person can answer. Any
 * other state shows the options read-only.
 */
export function QuestionCard({ question, state, answeredBy, busy, disabled, waiting, onAnswer }: {
  question: WorkbenchQuestionEvent; state: 'open' | 'answered'; answeredBy: WorkbenchMessageSender | null;
  busy: boolean; disabled: boolean;
  /** The chat runs or has a message on its way. */
  waiting: boolean;
  onAnswer(text: string): void;
}) {
  const c = useTheme();
  const [answers, setAnswers] = useState<QuestionAnswer[]>(() => question.questions.map(() => ({ selected: [] })));
  const open = state === 'open' && !waiting;
  const blocked = disabled || busy;
  const instant = sendsOnPick(question);
  const complete = answers.every((answer) => isQuestionAnswered(answer));
  const many = question.questions.length > 1;

  const send = (next: QuestionAnswer[]) => { if (!blocked) onAnswer(formatQuestionAnswers(question, next)); };
  const update = (index: number, answer: QuestionAnswer) => setAnswers((current) => current.map((a, i) => (i === index ? answer : a)));
  const pick = (index: number, item: WorkbenchQuestionItem, label: string) => {
    const current = answers[index];
    if (instant) return send([{ selected: [label] }]);
    if (item.multiSelect) {
      update(index, { ...current, selected: current.selected.includes(label) ? current.selected.filter((l) => l !== label) : [...current.selected, label] });
    } else update(index, { selected: [label] });
  };
  const setOther = (index: number, item: WorkbenchQuestionItem, other: string) => {
    const current = answers[index];
    update(index, item.multiSelect || !other.trim() ? { ...current, other } : { selected: [], other });
  };

  return <View style={[styles.plan, { borderColor: open ? withAlpha(c.information, 0.5) : c.border, backgroundColor: open ? withAlpha(c.information, 0.04) : c.paper }]}>
    <View style={[styles.planHeader, { borderColor: c.border }]}>
      <SymbolView name={{ ios: 'questionmark.bubble', android: 'help' }} size={13} tintColor={c.information} />
      <AppText variant="caption" tone="muted" accessibilityRole="header" style={{ flex: 1 }}>{many ? 'Questions' : 'Question'}</AppText>
      {state === 'answered' ? <AppText variant="caption" tone="success">{answeredLabel(answeredBy)}</AppText> : null}
    </View>
    <View style={[styles.planBody, styles.questionBody]}>
      {question.questions.map((item, index) => {
        const answer = answers[index];
        const role = instant ? 'button' : item.multiSelect ? 'checkbox' : 'radio';
        return <View key={index} style={styles.questionItem}>
          <View style={styles.questionTitle}>
            {item.header ? <Text style={[type.caption, sans(600), styles.chip, { color: c.information, backgroundColor: withAlpha(c.information, 0.1) }]}>{item.header}</Text> : null}
            <Text selectable style={[type.body, sans(600), { color: c.text, flex: 1 }]}>{item.question}</Text>
          </View>
          {open && item.multiSelect ? <AppText variant="caption" tone="muted">Pick one or more.</AppText> : null}
          {item.options.map((option) => {
            const selected = answer.selected.includes(option.label);
            const body = <>
              <Text style={[type.body, { color: c.text }]}>{option.label}</Text>
              {option.description ? <Text style={[type.meta, { color: c.muted }]}>{option.description}</Text> : null}
            </>;
            if (!open) return <View key={option.label} style={[styles.option, { borderColor: c.border }]}>{body}</View>;
            return <Pressable key={option.label} accessibilityRole={role} disabled={blocked}
              accessibilityLabel={option.description ? `${option.label}. ${option.description}` : option.label}
              accessibilityState={{ disabled: blocked, ...(role === 'button' ? {} : { checked: selected }) }}
              onPress={() => pick(index, item, option.label)}
              style={({ pressed }) => [styles.option, {
                borderColor: selected ? c.information : c.border,
                backgroundColor: selected ? withAlpha(c.information, 0.1) : pressed ? c.surface : c.background,
                opacity: blocked ? 0.5 : 1,
              }]}>{body}</Pressable>;
          })}
          {open ? <View style={styles.otherRow}>
            <View style={{ flex: 1 }}>
              <Input value={answer.other ?? ''} editable={!blocked} onChangeText={(text) => setOther(index, item, text)}
                placeholder={item.options.length ? 'Other' : 'Type your answer'} returnKeyType="send"
                accessibilityLabel={`${item.options.length ? 'Other answer' : 'Your answer'} ${index + 1}`}
                onSubmitEditing={() => { if (complete) send(answers); }} />
            </View>
            {instant ? <IconButton label="Send answer" symbol={{ ios: 'arrow.up', android: 'arrow_upward' }}
              disabled={blocked || !answer.other?.trim()} onPress={() => send(answers)} /> : null}
          </View> : null}
        </View>;
      })}
    </View>
    {open && !instant ? <View style={[styles.planActions, { borderColor: c.border }]}>
      <Button size="sm" title={many ? 'Send answers' : 'Send answer'} icon={{ ios: 'arrow.up', android: 'arrow_upward' }} loading={busy}
        disabled={blocked || !complete} onPress={() => send(answers)} />
    </View> : null}
  </View>;
}

export function FailedLine({ text }: { text: string }) {
  const c = useTheme();
  const mark = useHighlighter();
  return <View accessible accessibilityRole="alert" accessibilityLabel={`Turn failed. ${text}`} style={styles.failed}>
    <SymbolView name={{ ios: 'exclamationmark.circle', android: 'error' }} size={14} tintColor={c.destructive} />
    <Text selectable style={[type.meta, { color: c.destructive, flex: 1 }]}><Text style={sans(600)}>{mark('Turn failed. ')}</Text>{mark(text)}</Text>
  </View>;
}

export function QueuedBubble({ text, fromTalyn }: { text: string; fromTalyn: boolean }) {
  const c = useTheme();
  const mark = useHighlighter();
  return <View style={styles.userWrap}>
    <View accessible accessibilityLabel={`${fromTalyn ? 'From Talyn' : 'Queued'}: ${text}`} style={[styles.bubble, styles.queued, { borderColor: c.border }]}>
      <Text numberOfLines={6} style={[type.body, { color: c.muted }]}>{mark(text)}</Text>
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
  questionBody: { gap: 14 },
  questionItem: { gap: 6 },
  questionTitle: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  chip: { borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden' },
  option: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 8, gap: 2 },
  otherRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  failed: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingVertical: 6 },
});
