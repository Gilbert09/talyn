import type { CodeReviewDismissReason, CodeReviewFinding, CodeReviewPreset, CodeReviewPublic, CodeReviewSeverity } from '@talyn/client/native';
import { CODE_REVIEW_DISMISS_REASON_LABELS, CODE_REVIEW_DISMISS_REASONS, CODE_REVIEW_PRESET_BLURBS, CODE_REVIEW_PRESET_LABELS,
  CODE_REVIEW_PRESETS, CODE_REVIEW_SEVERITY_GROUP_LABELS, codeReviewLensLabel, codeReviewLensNames, codeReviewLensTally,
  codeReviewPresetFacts, codeReviewProgress } from '@talyn/shared';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';

import { useMobileRuntime } from '../../auth/AuthProvider';
import { AppText, BottomBar, Button, Disclosure, Dot, Notice, Pill, SectionLabel, Segmented, SheetModal, toneColor, type SheetRequest,
  type Tone } from '../../components/UI';
import { openExternal, safeExternalUrl } from '../../components/Workflow';
import { errorMessage, showActionError } from '../../lib/errors';
import { mono, radius, sans, useTheme, withAlpha } from '../../theme/tokens';
import { useResource } from '../../workflow/hooks';
import type { CodeReviewData } from '../../workflow/store';
import { Markdown } from '../chat/Markdown';
import { bucketFindings, droppedFindings, findingLocation, findingMeta, fixableIds, fixedFindings, groupFindings, notNeededCount,
  plainCopy, postConfirmation, postToPrState, reviewHeadline, reviewRunning, SEVERITY_TONE } from './codeReview';

const POLL = 5000;
type Busy = 'start' | 'stop' | 'fix' | 'post' | null;

/**
 * The code review of one PR: the server's review and findings, the ticked
 * findings, and the actions. Mirrors web `FindingsTab`. The screen holds it so
 * the selection bar can sit in the screen's bottom bar.
 */
export function useCodeReview(id: string, options: { seed?: CodeReviewPublic | null; reportingBar: CodeReviewSeverity; enabled: boolean }) {
  const { workflow } = useMobileRuntime();
  const state = useResource<CodeReviewData>('codeReview', id, options.enabled && Boolean(id));
  const review = state.data ? state.data.review : options.seed ?? null;
  const findings = useMemo(() => state.data?.findings ?? [], [state.data]);
  const [preset, setPreset] = useState<CodeReviewPreset | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const running = reviewRunning(review);
  const fixing = review?.phase === 'fixing';
  const groups = useMemo(() => groupFindings(findings, options.reportingBar), [findings, options.reportingBar]);
  const post = useMemo(() => postToPrState({ running, shown: groups.flatMap((group) => group.items), ticked: selected }), [running, groups, selected]);
  const pull = state.data?.pullRequest;
  const prLabel = pull ? `${pull.owner}/${pull.repo}#${pull.number}` : null;

  // The socket keeps the review current, not its findings, so poll while something runs. Web does the same.
  useEffect(() => {
    if (!running || !options.enabled || !id) return undefined;
    const timer = setInterval(() => { void workflow.load('codeReview', id); }, POLL);
    return () => clearInterval(timer);
  }, [running, options.enabled, id, workflow]);
  // A new cycle or commit gives every finding a new id, so an old selection must not carry over.
  useEffect(() => { setSelected(new Set()); }, [id, review?.id, review?.reviewedHeadSha]);
  useEffect(() => { setNotice(null); }, [id]);

  const run = useCallback(async (kind: Exclude<Busy, null>, title: string, action: () => Promise<void>) => {
    setBusy(kind);
    try { await action(); } catch (error) { showActionError(title, error); } finally { setBusy(null); }
  }, []);
  const start = () => run('start', 'Could not start the review', async () => {
    setNotice(null);
    await workflow.startCodeReview(id, preset ?? state.data?.defaultPreset ?? 'standard');
  });
  const stop = () => run('stop', fixing ? 'Could not stop the fix' : 'Could not stop the review',
    () => workflow.stopCodeReview(id, fixing ? review?.fixTaskId : null));
  const fix = (ids: string[]) => {
    if (!ids.length) return;
    void run('fix', 'Could not start the fix', async () => {
      setNotice(null);
      try {
        await workflow.fixCodeReviewFindings(id, ids);
        setSelected(new Set());
      } catch (error) {
        // A full task slot defers the fix rather than refusing it, as on web. Say so plainly.
        const message = errorMessage(error, '');
        if (message.includes('slot')) { setNotice(message); return; }
        throw error;
      }
    });
  };
  const postFindings = () => {
    const ids = post.ids;
    if (!ids.length) return;
    const copy = postConfirmation(ids.length, prLabel);
    Alert.alert(copy.title, copy.message, [
      { text: 'Cancel', style: 'cancel', isPreferred: true },
      { text: 'Post to PR', onPress: () => void run('post', 'Could not post to the pull request', async () => {
        const result = await workflow.postCodeReviewFindings(id, ids);
        setSelected(new Set());
        setNotice(`Posted ${result.posted} finding${result.posted === 1 ? '' : 's'} to the pull request.`);
      }) },
    ]);
  };
  const dismiss = (finding: CodeReviewFinding, reason?: CodeReviewDismissReason) => {
    setSelected((prev) => { const next = new Set(prev); next.delete(finding.id); return next; });
    workflow.dismissCodeReviewFinding(id, finding.id, reason).catch((error: unknown) => showActionError('Could not dismiss the finding', error));
  };
  const restore = (finding: CodeReviewFinding) => {
    workflow.undismissCodeReviewFinding(id, finding.id).catch((error: unknown) => showActionError('Could not put the finding back', error));
  };
  const toggle = (findingId: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(findingId)) next.delete(findingId); else next.add(findingId);
    return next;
  });
  const selectAll = (ids: string[]) => setSelected((prev) => new Set([...prev, ...ids]));
  return { id, state, review, findings, groups, running, fixing, post, busy, notice, selected, preset: preset ?? state.data?.defaultPreset ?? 'standard',
    reportingBar: options.reportingBar, setPreset, start, stop, fix, postFindings, dismiss, restore, toggle, selectAll,
    clear: () => setSelected(new Set()) };
}
export type CodeReviewController = ReturnType<typeof useCodeReview>;

/** "3 selected · Clear · Fix selected". Shown in the screen's bottom bar while findings are ticked. */
export function CodeReviewSelectionBar({ review }: { review: CodeReviewController }) {
  return <BottomBar>
    <AppText variant="meta" tone="muted" style={{ flex: 1 }}>{review.selected.size} selected</AppText>
    <Button variant="quiet" size="sm" title="Clear" onPress={review.clear} />
    <Button size="sm" title="Fix selected" icon={{ ios: 'wrench.and.screwdriver', android: 'build' }} loading={review.busy === 'fix'}
      disabled={review.busy !== null} onPress={() => review.fix([...review.selected])} />
  </BottomBar>;
}

function PresetPicker({ value, onChange }: { value: CodeReviewPreset; onChange(preset: CodeReviewPreset): void }) {
  return <View style={{ gap: 8 }}>
    <Segmented<CodeReviewPreset> accessibilityLabel="Review depth" value={value} onChange={onChange}
      options={CODE_REVIEW_PRESETS.map((preset) => ({ value: preset, label: CODE_REVIEW_PRESET_LABELS[preset] }))} />
    <AppText variant="meta" tone="muted">{CODE_REVIEW_PRESET_BLURBS[value]}</AppText>
    <View style={{ gap: 2 }}>
      {codeReviewPresetFacts(value).map((fact) => <AppText key={fact} variant="meta" tone="muted">· {plainCopy(fact)}</AppText>)}
    </View>
  </View>;
}

/** Start a review: the depth, what it means, and the start button. Opened from the PR menu and the Findings tab. */
export function CodeReviewStartSheet({ review: cr, visible, onClose, onStarted }: {
  review: CodeReviewController; visible: boolean; onClose(): void; onStarted(): void;
}) {
  const start = async () => { await cr.start(); onClose(); onStarted(); };
  return <SheetModal visible={visible} onClose={onClose} title="Review with Talyn">
    <View style={local.sheet}>
      <AppText variant="meta" tone="muted">Findings show up here, in Talyn. Nothing is posted to GitHub unless you post it.</AppText>
      <PresetPicker value={cr.preset} onChange={cr.setPreset} />
      <Button title="Start review" icon={{ ios: 'text.magnifyingglass', android: 'manage_search' }}
        loading={cr.busy === 'start'} disabled={cr.busy !== null} onPress={() => void start()} />
    </View>
  </SheetModal>;
}

function Progress({ fraction, label }: { fraction: number | null; label: string }) {
  const c = useTheme();
  return <View accessibilityRole="progressbar" accessibilityLabel={label}
    accessibilityValue={fraction === null ? undefined : { min: 0, max: 100, now: Math.round(fraction * 100) }}
    style={[local.track, { backgroundColor: c.surface }]}>
    <View style={[local.fill, { backgroundColor: c.primaryAction, width: `${Math.round((fraction ?? 0.15) * 100)}%`, opacity: fraction === null ? 0.5 : 1 }]} />
  </View>;
}

/** Inline code in a one-line title, in mono. Agents write titles with backticks. */
function InlineTitle({ text }: { text: string }) {
  const parts = text.split('`');
  return <AppText variant="meta" style={sans(600)}>
    {parts.map((part, index) => index % 2 ? <AppText key={index} variant="mono">{part}</AppText> : part)}
  </AppText>;
}

function CheckBox({ checked, label, onPress }: { checked: boolean; label: string; onPress(): void }) {
  const c = useTheme();
  return <Pressable accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{ checked }} hitSlop={10} onPress={onPress} style={local.check}>
    <SymbolView name={checked ? { ios: 'checkmark.square.fill', android: 'check_box' } : { ios: 'square', android: 'check_box_outline_blank' }}
      size={20} tintColor={checked ? c.primaryAction : c.muted} />
  </Pressable>;
}

function FindingCard({ finding, review, names, expanded, onToggleExpanded, openSheet }: {
  finding: CodeReviewFinding; review: CodeReviewController; names: Record<string, string>; expanded: boolean;
  onToggleExpanded(): void; openSheet(request: SheetRequest): void;
}) {
  const c = useTheme();
  const { workflow } = useMobileRuntime();
  const [detail, setDetail] = useState<CodeReviewFinding | null>(null);
  const [failed, setFailed] = useState(false);
  // The list leaves out the body, suggestion and anchor. Fetch them once, the first time the card opens.
  useEffect(() => {
    if (!expanded || detail || failed) return undefined;
    let cancelled = false;
    workflow.codeReviewFinding(review.id, finding.id).then((full) => { if (!cancelled) setDetail(full); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [expanded, detail, failed, workflow, review.id, finding.id]);
  const full = detail ?? finding;
  const tone = SEVERITY_TONE[finding.severity] as Tone;
  const meta = findingMeta(finding, { stillChecking: review.running && !review.fixing, names });
  const ticked = review.selected.has(finding.id);
  const dismiss = () => openSheet({ title: 'Why dismiss it?', message: 'A reason helps the reviewer. You can skip it.', actions: [
    ...CODE_REVIEW_DISMISS_REASONS.map((reason) => ({ label: CODE_REVIEW_DISMISS_REASON_LABELS[reason], onPress: () => review.dismiss(finding, reason) })),
    { label: 'Skip', onPress: () => review.dismiss(finding) },
  ] });
  return <View style={[local.card, { borderColor: c.border }]}>
    <View style={local.cardHead}>
      {finding.disposition === 'selected'
        ? <View accessibilityLabel="An agent is fixing this now" style={local.check}>
          <SymbolView name={{ ios: 'wrench.and.screwdriver', android: 'build' }} size={16} tintColor={c.primaryAction} />
        </View>
        : <CheckBox checked={ticked} label={`Select "${finding.title}" to fix`} onPress={() => review.toggle(finding.id)} />}
      <View style={{ paddingTop: 7 }}><Dot color={toneColor(c, tone)} size={7} /></View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} accessibilityLabel={`${finding.title}. ${meta.join(', ')}`}
        onPress={onToggleExpanded} style={{ flex: 1, gap: 2, paddingVertical: 2 }}>
        <InlineTitle text={finding.title} />
        <AppText variant="caption" tone="muted" numberOfLines={3}>
          <AppText variant="caption" tone="muted" style={mono(400)}>{meta[0]}</AppText>
          {meta.length > 1 ? ` · ${meta.slice(1).join(' · ')}` : ''}
        </AppText>
      </Pressable>
    </View>
    {expanded ? <View style={[local.cardBody, { borderTopColor: c.border }]}>
      {!detail && !failed ? <AppText variant="caption" tone="muted">Loading the full finding.</AppText> : null}
      {full.body ? <Markdown text={full.body} /> : null}
      {full.anchor ? <View style={[local.code, { backgroundColor: c.surface }]}>
        <AppText variant="section" tone="muted">{full.anchorVerified ? 'The code it read' : 'The code it quoted, not found at this location'}</AppText>
        <AppText variant="mono" selectable style={{ fontSize: 12, lineHeight: 17 }}>{full.anchor}</AppText>
      </View> : null}
      {full.suggestion ? <View style={[local.code, { backgroundColor: c.surface }]}>
        <AppText variant="section" tone="muted">Suggested change</AppText>
        <Markdown text={full.suggestion} />
      </View> : null}
      <AppText variant="caption" tone="muted">{[
        `Raised by ${full.lenses.map((lens) => codeReviewLensLabel(lens, names)).join(', ') || 'a reviewer'}${full.lenses.length > 1 ? ', independently' : ''}`,
        full.confidence !== null ? `Confidence ${full.confidence}%` : '',
        full.anchorVerified ? 'Location confirmed' : 'Location not confirmed',
        full.seenCount > 1 ? `Seen in ${full.seenCount} reviews` : '',
      ].filter(Boolean).join(' · ')}</AppText>
      {full.verdictReason ? <AppText variant="caption" tone="muted" style={{ fontStyle: 'italic' }}>Checker's note: {full.verdictReason}</AppText> : null}
      <View style={{ alignSelf: 'flex-start' }}>
        <Button variant="quiet" size="sm" title="Dismiss" icon={{ ios: 'checkmark', android: 'check' }} onPress={dismiss} />
      </View>
    </View> : null}
  </View>;
}

/** The PR detail's Findings tab: follow a review, read and act on its findings. Starting one opens the start sheet. */
export function CodeReviewSection({ review: cr, open, openSheet, onReviewRequest }: {
  review: CodeReviewController; open: boolean; openSheet(request: SheetRequest): void; onReviewRequest(): void;
}) {
  const c = useTheme();
  const { review, findings, groups, running, fixing, post, busy } = cr;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const names = useMemo(() => codeReviewLensNames(review?.customReviewers), [review?.customReviewers]);
  const tally = useMemo(() => codeReviewLensTally(findings, names), [findings, names]);
  const fixable = useMemo(() => fixableIds(groups), [groups]);
  const bucket = useMemo(() => bucketFindings(findings, cr.reportingBar), [findings, cr.reportingBar]);
  const dropped = useMemo(() => droppedFindings(findings), [findings]);
  const fixed = useMemo(() => fixedFindings(findings), [findings]);
  const beingFixed = findings.filter((finding) => finding.disposition === 'selected').length;
  // Blockers open on first sight, and only then, so closing one sticks.
  useEffect(() => {
    const blockers = findings.filter((finding) => finding.severity === 'blocker' && finding.disposition === 'open').map((finding) => finding.id);
    if (blockers.length) setExpanded((prev) => blockers.every((id) => prev.has(id)) ? prev : new Set([...prev, ...blockers]));
  }, [findings]);
  const toggleExpanded = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const disabled = busy !== null;

  if (!review) {
    return <View style={local.section}>
      {cr.state.status === 'loading' && !cr.state.data ? <AppText variant="meta" tone="muted">Loading the review.</AppText> : open ? <>
        <View style={[local.panel, { borderColor: c.border, backgroundColor: c.paper }]}>
          <AppText variant="rowTitle">Have Talyn review this pull request</AppText>
          <AppText variant="meta" tone="muted">Findings show up here, in Talyn.</AppText>
        </View>
        <View style={{ alignSelf: 'flex-start' }}>
          <Button size="sm" title="Review this pull request" icon={{ ios: 'text.magnifyingglass', android: 'manage_search' }}
            loading={busy === 'start'} disabled={disabled} onPress={onReviewRequest} />
        </View>
      </> : <AppText variant="meta" tone="muted">This pull request was not reviewed.</AppText>}
    </View>;
  }

  const progress = codeReviewProgress(review);
  const lensesRun = review.lensesRun.map((lens) => codeReviewLensLabel(lens, names)).join(', ');
  const skipped = notNeededCount(review);
  const scope = [
    `${CODE_REVIEW_PRESET_LABELS[review.preset]} review${review.headShaShort ? ` of ${review.headShaShort}` : ''}`,
    review.runsTotal > 0 ? `${review.runsTotal} passes${review.chunkTotal > 1 ? ` over ${review.chunkTotal} chunks` : ''}` : '',
    lensesRun ? `read by ${lensesRun}${skipped > 0 ? ` (${skipped} not needed here)` : ''}` : '',
    review.staleForHead ? 'there are newer commits' : '',
  ].filter(Boolean).join(' · ');
  const stale = review.staleForHead && !running;
  return <View style={local.section}>
    <View style={[local.panel, { borderColor: stale ? withAlpha(c.warning, 0.45) : c.border,
      backgroundColor: stale ? withAlpha(c.warning, c.mode === 'dark' ? 0.08 : 0.05) : c.paper }]}>
      <AppText variant="rowTitle" accessibilityLiveRegion="polite">{running ? progress.label : reviewHeadline(review)}</AppText>
      <AppText variant="caption" tone="muted">{scope}</AppText>
      {running ? <Progress fraction={progress.fraction} label={progress.label} /> : null}
      {!running && review.phase === 'failed' && review.failureReason ? <AppText variant="meta" tone="destructive">{review.failureReason}</AppText> : null}
      {review.deferredSince && running ? <AppText variant="meta" tone="warning">Waiting for a runner to become free.</AppText> : null}
      <View style={local.actions}>
        {groups.length > 0 ? <Button variant="secondary" size="sm" title={post.label} icon={{ ios: 'text.bubble', android: 'comment' }}
          accessibilityLabel={post.disabledReason ? `${post.label}. ${post.disabledReason}` : post.label}
          loading={busy === 'post'} disabled={disabled || post.disabledReason !== null} onPress={cr.postFindings} /> : null}
        {running ? <Button variant="secondary" size="sm" title={fixing ? 'Stop the fix' : 'Stop'} loading={busy === 'stop'} disabled={disabled}
          onPress={() => void cr.stop()} /> : <>
          {fixable.length > 0 ? <Button variant="secondary" size="sm" title={`Fix all ${fixable.length}`} icon={{ ios: 'wrench.and.screwdriver', android: 'build' }}
            loading={busy === 'fix'} disabled={disabled} onPress={() => cr.fix(fixable)} /> : null}
          {open ? <Button variant={review.staleForHead ? 'primary' : 'secondary'} size="sm" title={review.staleForHead ? 'Review this commit' : 'Review again'}
            icon={{ ios: 'arrow.counterclockwise', android: 'refresh' }} loading={busy === 'start'} disabled={disabled} onPress={onReviewRequest} /> : null}
        </>}
      </View>
      {post.disabledReason && groups.length > 0 && !running ? <AppText variant="caption" tone="muted">{post.disabledReason}</AppText> : null}
    </View>

    {running && !fixing && groups.length > 0 ? <AppText variant="meta" tone="muted">
      Showing what the reviewers have found so far. These have not been checked yet, and some are usually dropped.</AppText> : null}
    {fixing ? <Notice tone="primary" message={`${beingFixed ? `Fixing ${beingFixed} finding${beingFixed === 1 ? '' : 's'}` : 'Fixing'}. An agent is working on a branch. It pushes one commit when it is done, and the findings it addressed are marked fixed until the next review confirms them.`} /> : null}
    {cr.notice ? <Notice tone="warning" message={cr.notice} /> : null}
    {!running && review.phase === 'ready' && groups.length === 0 ? <View style={[local.panel, { borderColor: c.border }]}>
      <AppText variant="meta" style={sans(600)}>Nothing to flag.</AppText>
      <AppText variant="meta" tone="muted">A {CODE_REVIEW_PRESET_LABELS[review.preset].toLowerCase()} review of {review.headShaShort} found no blockers or problems worth fixing.</AppText>
    </View> : null}

    {groups.map((group) => <View key={group.severity} style={{ gap: 8 }}>
      <SectionLabel title={`${CODE_REVIEW_SEVERITY_GROUP_LABELS[group.severity]} ${group.items.length}`}
        trailing={<Button variant="quiet" size="sm" title="Select all" accessibilityLabel={`Select all ${CODE_REVIEW_SEVERITY_GROUP_LABELS[group.severity]}`}
          onPress={() => cr.selectAll(group.items.filter((finding) => finding.disposition !== 'selected').map((finding) => finding.id))} />} />
      {group.items.map((finding) => <FindingCard key={finding.id} finding={finding} review={cr} names={names}
        expanded={expanded.has(finding.id)} onToggleExpanded={() => toggleExpanded(finding.id)} openSheet={openSheet} />)}
    </View>)}

    {!running && review.funnel.raised > 0 ? <View style={{ gap: 6 }}>
      <AppText variant="caption" tone="muted">{`${review.funnel.raised} raised · ${review.funnel.kept} kept after checking${review.funnel.rejected > 0 ? ` · ${review.funnel.rejected} dropped` : ''}`}</AppText>
      {tally.length ? <View style={local.tally} accessibilityLabel={`Found by ${tally.map((entry) => `${entry.label} ${entry.count}`).join(', ')}`}>
        <AppText variant="caption" tone="muted">Found by</AppText>
        {tally.map((entry) => <Pill key={entry.lens} label={`${entry.label} ${entry.count}`} />)}
      </View> : null}
    </View> : null}

    {fixed.length ? <Disclosure title={`Fixed (${fixed.length}). Review again to confirm it held.`}>
      {fixed.map((finding) => {
        const url = finding.fixedCommitUrl ? safeExternalUrl(finding.fixedCommitUrl) : null;
        return <View key={finding.id} style={local.mini}>
          <InlineTitle text={finding.title} />
          <AppText variant="caption" tone="muted" style={mono(400)}>{findingLocation(finding)}</AppText>
          {url && finding.fixedHeadShaShort ? <Pressable accessibilityRole="link" accessibilityLabel={`Fixed in ${finding.fixedHeadShaShort}`} onPress={() => openExternal(url)}>
            <AppText variant="caption" tone="primary">Fixed in {finding.fixedHeadShaShort}</AppText>
          </Pressable> : <AppText variant="caption" tone="muted">The fix run reported this done, but pushed no commit for it.</AppText>}
        </View>;
      })}
    </Disclosure> : null}

    {dropped.length ? <Disclosure title={`Dropped by the checker (${dropped.length}). Raised, then judged not worth your time.`}>
      {dropped.map((finding) => <View key={finding.id} style={local.mini}>
        <InlineTitle text={finding.title} />
        <AppText variant="caption" tone="muted" style={mono(400)}>{findingLocation(finding)}</AppText>
        <AppText variant="caption" tone="muted" style={{ fontStyle: 'italic' }}>{finding.verdictReason || 'No reason was recorded for this one.'}</AppText>
      </View>)}
    </Disclosure> : null}

    {bucket.length ? <Disclosure title={`Also looked at (${bucket.length}). Nitpicks, and things you dismissed.`}>
      {bucket.map((finding) => <View key={finding.id} style={[local.mini, local.bucketRow]}>
        <View style={{ flex: 1, gap: 2 }}>
          <InlineTitle text={finding.title} />
          <AppText variant="caption" tone="muted" numberOfLines={2}>
            {findingLocation(finding)}{finding.dismissedReason ? ` · ${CODE_REVIEW_DISMISS_REASON_LABELS[finding.dismissedReason]}` : ''}
          </AppText>
        </View>
        {finding.disposition === 'dismissed' ? <Button variant="quiet" size="sm" title="Put back" accessibilityLabel={`Put "${finding.title}" back on the list`}
          onPress={() => cr.restore(finding)} /> : null}
      </View>)}
    </Disclosure> : null}
  </View>;
}

const local = StyleSheet.create({
  section: { gap: 10 },
  sheet: { gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16 },
  panel: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: 12, gap: 6 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 4 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 10 },
  cardBody: { borderTopWidth: StyleSheet.hairlineWidth, padding: 10, gap: 8 },
  check: { width: 24, minHeight: 24, alignItems: 'center', justifyContent: 'center' },
  code: { borderRadius: radius.sm, padding: 8, gap: 4 },
  tally: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  mini: { gap: 2, paddingVertical: 6 },
  bucketRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
