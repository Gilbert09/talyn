import type { MergeQueuePublic, MergeQueueTimelineEvent, PRBlockingReason, PRCheckContext, PRChecks, PRFile, PRHumanGate,
  PRReviewDetail, PRReviewThread } from '@talyn/client/native';
import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AppText, Button, Disclosure, Dot, Pill, Row, SectionLabel, SheetModal, Spinner, toneColor, type Symbol, type Tone } from '../../components/UI';
import { openExternal, safeExternalUrl, StateNotice } from '../../components/Workflow';
import { longTime, shortTime } from '../../lib/time';
import { mono, radius, sans, type, useTheme } from '../../theme/tokens';
import type { Resource } from '../../workflow/model';
import { queueLabel } from '../../workflow/model';
import { Markdown } from '../chat/Markdown';
import { PatchView } from '../sessions/DiffView';
import { checksLine } from './actions';
import { descriptionIsLong, FILE_STATUS_LABEL, fileTotals, groupChecks, lastHunkLines, REVIEW_STATE_LABEL, reviewTimeline,
  type PrDetailTab } from './detailModel';
import { queueBudgetsLine, queueStatusLine } from './lists';

type Loaded<T> = Resource<T> & { refresh(): unknown };

export interface TabSpec { key: PrDetailTab; label: string; badge?: string }

/** A compact tab strip that scrolls sideways when it does not fit, like the chat tabs. */
export function DetailTabStrip({ tabs, value, onChange }: { tabs: TabSpec[]; value: PrDetailTab; onChange(tab: PrDetailTab): void }) {
  const c = useTheme();
  return <View style={[local.tabsWrap, { borderColor: c.border }]}>
    <ScrollView horizontal accessibilityRole="tablist" accessibilityLabel="Pull request sections" showsHorizontalScrollIndicator={false}
      contentContainerStyle={local.tabs}>
      {tabs.map((tab) => {
        const active = tab.key === value;
        return <Pressable key={tab.key} accessibilityRole="tab" accessibilityState={{ selected: active }} hitSlop={{ top: 6, bottom: 6 }}
          accessibilityLabel={tab.badge ? `${tab.label}, ${tab.badge}` : tab.label} onPress={() => onChange(tab.key)}
          style={[local.tab, { borderBottomColor: active ? c.primary : 'transparent' }]}>
          <Text numberOfLines={1} style={[type.meta, sans(active ? 600 : 500), { color: active ? c.text : c.muted }]}>{tab.label}</Text>
          {tab.badge ? <Text style={[type.caption, local.badge, { color: c.muted, backgroundColor: c.surface }]}>{tab.badge}</Text> : null}
        </Pressable>;
      })}
    </ScrollView>
  </View>;
}

/** The PR description, folded after about twelve lines. */
export function Description({ body, loading }: { body: string; loading: boolean }) {
  const c = useTheme();
  const long = descriptionIsLong(body);
  const [open, setOpen] = useState(false);
  if (!body.trim()) {
    return loading ? <View style={local.inline}><Spinner /><AppText variant="meta" tone="muted">Loading the description</AppText></View>
      : <AppText variant="meta" tone="muted">No description provided.</AppText>;
  }
  return <View style={{ gap: 6 }}>
    <View style={long && !open ? local.folded : null}>
      <Markdown text={body} />
    </View>
    {long ? <View style={[local.more, { borderTopColor: open ? 'transparent' : c.border }]}>
      <Button variant="quiet" size="sm" title={open ? 'Show less' : 'Show more'} onPress={() => setOpen(!open)} />
    </View> : null}
  </View>;
}

const TIMELINE_PREVIEW = 8;
function Timeline({ events, now }: { events: MergeQueueTimelineEvent[]; now: number }) {
  const c = useTheme();
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(0, TIMELINE_PREVIEW);
  return <View accessibilityRole="list" accessibilityLabel="Merge queue timeline">
    {shown.map((event, index) => <View key={`${event.at}:${event.trigger}:${index}`} style={local.event}
      accessible accessibilityLabel={`${queueLabel(event.toStatus)}. ${longTime(event.at)}.${event.message ? ` ${event.message}` : ''}`}>
      <View style={local.rail}>
        <Dot color={index === 0 ? c.primaryAction : c.muted} size={8} />
        {index < shown.length - 1 ? <View style={[local.line, { backgroundColor: c.border }]} /> : null}
      </View>
      <View style={{ flex: 1, gap: 2, paddingBottom: 12 }}>
        <View style={local.inline}>
          <AppText variant="meta" style={{ flex: 1 }}>{queueLabel(event.toStatus)}</AppText>
          <AppText variant="caption" tone="muted">{shortTime(event.at, now)}</AppText>
        </View>
        {event.message ? <AppText variant="meta" tone="muted" numberOfLines={4}>{event.message}</AppText> : null}
      </View>
    </View>)}
    {events.length > TIMELINE_PREVIEW ? <View style={{ alignSelf: 'flex-start' }}>
      <Button variant="quiet" size="sm" title={all ? 'Show fewer' : `Show all ${events.length}`} onPress={() => setAll(!all)} />
    </View> : null}
  </View>;
}

/** The Overview's merge queue: one status line, and its history in a sheet. */
export function QueueSection({ entry, sessionName, timeline, offline, now }: {
  entry: MergeQueuePublic | null | undefined; sessionName?: string | null; timeline: Loaded<{ events: MergeQueueTimelineEvent[] }>;
  offline: boolean; now: number;
}) {
  const [open, setOpen] = useState(false);
  const budgets = queueBudgetsLine(entry);
  // A blocked entry's reason is the next-step card's detail, so it is not repeated here.
  return <View style={{ gap: 6 }}>
    <SectionLabel title="Merge queue" />
    <AppText variant="meta">{queueStatusLine(entry, sessionName)}</AppText>
    <Row title="History" onPress={() => setOpen(true)} chevron divider={false} accessibilityLabel="Merge queue history" />
    <SheetModal visible={open} onClose={() => setOpen(false)} title="Merge queue history" full>
      <ScrollView contentContainerStyle={local.sheet}>
        {budgets ? <AppText variant="caption" tone="muted">{budgets}{entry?.headShaShort ? `. Counted for ${entry.headShaShort}. A new push resets them.` : ''}</AppText> : null}
        <StateNotice resource={timeline} offline={offline} refresh={() => { void timeline.refresh(); }} refreshLabel="Refresh queue timeline" />
        {timeline.data?.events.length ? <Timeline events={timeline.data.events} now={now} />
          : timeline.status === 'ready' ? <AppText variant="meta" tone="muted">No queue events yet.</AppText> : null}
      </ScrollView>
    </SheetModal>
  </View>;
}

function CheckLine({ check, tone, icon, tag }: { check: PRCheckContext; tone: Tone; icon: Symbol | 'spinner'; tag?: string }) {
  const c = useTheme();
  const url = check.url ? safeExternalUrl(check.url) : null;
  const color = toneColor(c, tone);
  const body = <View style={local.check}>
    {icon === 'spinner' ? <Spinner color={color} size={14} /> : <SymbolView name={icon} size={15} tintColor={color} />}
    <AppText variant="mono" numberOfLines={1} style={{ flex: 1 }}>{check.name}</AppText>
    {tag ? <Pill label={tag} tone="warning" /> : null}
    {url ? <SymbolView name={{ ios: 'arrow.up.right', android: 'open_in_new' }} size={12} tintColor={c.muted} /> : null}
  </View>;
  const label = `${check.name}. ${check.state.replace('_', ' ')}${tag ? `. ${tag}` : ''}`;
  return url ? <Pressable accessibilityRole="link" accessibilityLabel={label} onPress={() => openExternal(url)}
    style={({ pressed }) => ({ backgroundColor: pressed ? c.surface : 'transparent' })}>{body}</Pressable>
    : <View accessible accessibilityLabel={label}>{body}</View>;
}

const FAIL: Symbol = { ios: 'xmark.circle', android: 'cancel' };
const PASS: Symbol = { ios: 'checkmark.circle', android: 'check_circle' };
const SKIP: Symbol = { ios: 'minus.circle', android: 'remove_circle_outline' };

/** Failing first, then running, then the passed and skipped ones folded. */
export function ChecksTab({ contexts, checks, blockingReason, humanGates, url }: {
  contexts: PRCheckContext[] | undefined; checks: PRChecks | undefined; blockingReason?: PRBlockingReason | null;
  humanGates?: PRHumanGate[]; url: string | null;
}) {
  const groups = useMemo(() => groupChecks(contexts, blockingReason), [contexts, blockingReason]);
  if (!checks?.total) return <AppText variant="meta" tone="muted">No checks have run yet.</AppText>;
  const line = checksLine(checks);
  if (!contexts?.length) {
    return <View style={{ gap: 8 }}>
      {line ? <AppText variant="meta">{line}</AppText> : null}
      <AppText variant="meta" tone="muted">The check list needs live detail from GitHub.</AppText>
      {url ? <View style={{ alignSelf: 'flex-start' }}>
        <Button variant="secondary" size="sm" title="Open checks on GitHub" onPress={() => openExternal(`${url}/checks`)} />
      </View> : null}
    </View>;
  }
  const rest = groups.passed.length + groups.skipped.length;
  return <View style={{ gap: 12 }}>
    {line ? <AppText variant="meta" tone="muted">{line}</AppText> : null}
    {humanGates?.length ? <View style={local.pills}>{humanGates.map((gate, index) =>
      <Pill key={`${gate.id}:${index}`} label={`Needs a person: ${gate.label || gate.name}`} tone="warning" />)}</View> : null}
    {groups.failing.length ? <View accessibilityLabel="Failing checks">
      <SectionLabel title={`Failing ${groups.failing.length}`} />
      {groups.failing.map(({ check, optional, needsHuman }) => <CheckLine key={`${check.name}:${check.url ?? ''}`} check={check}
        tone={optional || needsHuman ? 'warning' : 'destructive'} icon={FAIL} tag={needsHuman ? 'Needs a person' : optional ? 'Not required' : undefined} />)}
    </View> : null}
    {groups.running.length ? <View accessibilityLabel="Running checks">
      <SectionLabel title={`Running ${groups.running.length}`} />
      {groups.running.map((check) => <CheckLine key={`${check.name}:${check.url ?? ''}`} check={check} tone="information" icon="spinner" />)}
    </View> : null}
    {rest ? <Disclosure title={`${groups.passed.length} passed, ${groups.skipped.length} skipped`}>
      {groups.passed.map((check) => <CheckLine key={`${check.name}:${check.url ?? ''}`} check={check} tone="success" icon={PASS} />)}
      {groups.skipped.map((check) => <CheckLine key={`${check.name}:${check.url ?? ''}`} check={check} tone="muted" icon={SKIP} />)}
    </Disclosure> : null}
  </View>;
}

function Counts({ added, removed }: { added: number; removed: number }) {
  return <Text style={[type.caption, { fontVariant: ['tabular-nums'] }]}>
    {added > 0 ? <AppText variant="caption" tone="success">+{added}</AppText> : null}
    {added > 0 && removed > 0 ? ' ' : ''}
    {removed > 0 ? <AppText variant="caption" tone="destructive">−{removed}</AppText> : null}
  </Text>;
}

/** The changed files. A tap opens the file's patch. */
export function FilesTab({ files, offline, url }: { files: Loaded<PRFile[]>; offline: boolean; url: string | null }) {
  const c = useTheme();
  const [selected, setSelected] = useState<PRFile | null>(null);
  const list = files.data;
  if (!list) return <StateNotice resource={files} offline={offline} refresh={() => { void files.refresh(); }} />;
  if (!list.length) return <AppText variant="meta" tone="muted">No file changes in this PR.</AppText>;
  const totals = fileTotals(list);
  return <View style={{ gap: 8 }}>
    <StateNotice resource={files} offline={offline} refresh={() => { void files.refresh(); }} />
    <View style={local.inline}>
      <AppText variant="meta" tone="muted" style={{ flex: 1 }}>{list.length} {list.length === 1 ? 'file' : 'files'} changed</AppText>
      <Counts {...totals} />
    </View>
    <View style={[local.list, { borderColor: c.border }]}>
      {list.map((file, index) => <Pressable key={file.filename} accessibilityRole="button" onPress={() => setSelected(file)}
        accessibilityLabel={`${file.filename}. ${FILE_STATUS_LABEL[file.status]}. ${file.additions} added, ${file.deletions} removed`}
        style={({ pressed }) => [local.file, { borderTopColor: index ? c.border : 'transparent', backgroundColor: pressed ? c.surface : 'transparent' }]}>
        <View style={{ flex: 1, gap: 2 }}>
          <AppText variant="mono" numberOfLines={1} ellipsizeMode="head">{file.filename}</AppText>
          <AppText variant="caption" tone="muted">{FILE_STATUS_LABEL[file.status]}</AppText>
        </View>
        <Counts added={file.additions} removed={file.deletions} />
      </Pressable>)}
    </View>
    {url ? <View style={{ alignSelf: 'flex-start' }}>
      <Button variant="quiet" size="sm" title="Open files on GitHub" onPress={() => openExternal(`${url}/files`)} />
    </View> : null}
    <SheetModal visible={selected !== null} onClose={() => setSelected(null)} title={selected?.filename.split('/').pop() ?? 'File'} full>
      {selected ? <ScrollView contentContainerStyle={local.sheet}>
        <AppText variant="caption" tone="muted" style={mono(400)}>{selected.filename}</AppText>
        {selected.patch ? <PatchView patch={selected.patch} />
          : <AppText variant="meta" tone="muted">{selected.status === 'renamed' ? 'Renamed with no content change.'
            : 'No text diff. It is a binary file, or the diff is too large. Open it on GitHub.'}</AppText>}
      </ScrollView> : null}
    </SheetModal>
  </View>;
}

function Author({ name, at, now }: { name: string; at: string | null; now: number }) {
  return <View style={local.inline}>
    <AppText variant="meta" style={[sans(600), { flexShrink: 1 }]} numberOfLines={1}>@{name}</AppText>
    {at ? <AppText variant="caption" tone="muted" accessibilityLabel={longTime(at)}>{shortTime(at, now)}</AppText> : null}
  </View>;
}

const REVIEW_TONE: Record<string, Tone> = { APPROVED: 'success', CHANGES_REQUESTED: 'destructive' };

function Thread({ thread, now }: { thread: PRReviewThread; now: number }) {
  const c = useTheme();
  const [open, setOpen] = useState(!thread.isResolved);
  const where = `${thread.path ?? 'Comment'}${thread.line != null ? `:${thread.line}` : ''}`;
  return <View style={[local.card, { borderColor: c.border }]}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}
      accessibilityLabel={`${where}. ${thread.isResolved ? 'Resolved' : 'Not resolved'}${thread.isOutdated ? '. Outdated' : ''}`}
      style={[local.cardHead, { backgroundColor: c.paper }]}>
      <AppText variant="caption" numberOfLines={1} ellipsizeMode="head" style={[mono(400), { flex: 1 }]}>{where}</AppText>
      {thread.isOutdated ? <Pill label="Outdated" /> : null}
      <Pill label={thread.isResolved ? 'Resolved' : 'Not resolved'} tone={thread.isResolved ? 'success' : 'warning'} />
    </Pressable>
    {open ? <View style={{ gap: 0 }}>
      {thread.diffHunk ? <ScrollView horizontal style={[local.hunk, { borderColor: c.border }]}>
        <Text style={[local.hunkText, { color: c.muted }]}>{lastHunkLines(thread.diffHunk)}</Text>
      </ScrollView> : null}
      {thread.comments.map((comment, index) => <View key={comment.id} style={[local.cardBody, index ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border } : null]}>
        <Author name={comment.author} at={comment.createdAt} now={now} />
        {comment.body.trim() ? <Markdown text={comment.body} /> : <AppText variant="meta" tone="muted">No content.</AppText>}
      </View>)}
    </View> : null}
  </View>;
}

/** Reviews, inline threads and comments, oldest first. Mirrors web `ReviewsTab`. */
export function ReviewsTab({ reviews, offline, url, now }: { reviews: Loaded<PRReviewDetail>; offline: boolean; url: string | null; now: number }) {
  const c = useTheme();
  const items = useMemo(() => reviewTimeline(reviews.data), [reviews.data]);
  if (!reviews.data) return <StateNotice resource={reviews} offline={offline} refresh={() => { void reviews.refresh(); }} />;
  const unresolved = reviews.data.threads.filter((thread) => !thread.isResolved).length;
  return <View style={{ gap: 10 }}>
    <StateNotice resource={reviews} offline={offline} refresh={() => { void reviews.refresh(); }} />
    {!items.length ? <AppText variant="meta" tone="muted">No reviews or comments yet.</AppText> : null}
    {unresolved ? <AppText variant="meta" tone="muted">{unresolved} inline {unresolved === 1 ? 'comment is' : 'comments are'} not resolved.</AppText> : null}
    {items.map((item) => item.kind === 'thread' ? <Thread key={item.key} thread={item.thread} now={now} />
      : item.kind === 'review' ? <View key={item.key} style={[local.card, { borderColor: c.border }]}>
        <View style={[local.cardHead, { backgroundColor: c.paper }]}>
          <View style={{ flex: 1 }}><Author name={item.review.author} at={item.review.submittedAt} now={now} /></View>
          <Pill label={REVIEW_STATE_LABEL[item.review.state] ?? 'Commented'} tone={REVIEW_TONE[item.review.state] ?? 'muted'} />
        </View>
        {item.review.body.trim() ? <View style={local.cardBody}><Markdown text={item.review.body} /></View> : null}
      </View>
      : <View key={item.key} style={[local.card, local.cardBody, { borderColor: c.border }]}>
        <Author name={item.comment.author} at={item.comment.createdAt} now={now} />
        {item.comment.body.trim() ? <Markdown text={item.comment.body} /> : <AppText variant="meta" tone="muted">No content.</AppText>}
      </View>)}
    {url ? <View style={{ alignSelf: 'flex-start' }}>
      <Button variant="quiet" size="sm" title="Open the conversation on GitHub" onPress={() => openExternal(url)} />
    </View> : null}
  </View>;
}

const local = StyleSheet.create({
  tabsWrap: { borderBottomWidth: StyleSheet.hairlineWidth, marginHorizontal: -16 },
  tabs: { paddingHorizontal: 12, gap: 2 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 40, paddingHorizontal: 8, borderBottomWidth: 2 },
  badge: { paddingHorizontal: 5, borderRadius: radius.pill, overflow: 'hidden' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  folded: { maxHeight: 12 * 22, overflow: 'hidden' },
  more: { alignSelf: 'stretch', alignItems: 'flex-start', borderTopWidth: StyleSheet.hairlineWidth },
  event: { flexDirection: 'row', gap: 10 },
  rail: { width: 10, alignItems: 'center', paddingTop: 5 },
  line: { width: StyleSheet.hairlineWidth * 2, flex: 1, marginTop: 4 },
  sheet: { gap: 10, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 24 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36, paddingVertical: 6, paddingHorizontal: 4 },
  list: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: 'hidden' },
  file: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: 'hidden' },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  cardBody: { gap: 6, paddingHorizontal: 10, paddingVertical: 8 },
  hunk: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 6 },
  hunkText: { ...mono(400), fontSize: 11.5, lineHeight: 16 },
});
