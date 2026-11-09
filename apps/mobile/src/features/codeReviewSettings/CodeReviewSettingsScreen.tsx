import { codeReviews, workspaces } from '@talyn/client/native';
import {
  CODE_REVIEW_PRESETS, CODE_REVIEW_PRESET_BLURBS, CODE_REVIEW_PRESET_LABELS, CODE_REVIEW_SEVERITY_LABELS, CODE_REVIEW_SEVERITY_ORDER,
  codeReviewPresetFacts,
  type CodeReviewCustomReviewer, type CodeReviewLensStat, type CodeReviewSettings, type CodeReviewSeverity, type Workspace,
} from '@talyn/shared';
import { SymbolView } from 'expo-symbols';
import { useState, type PropsWithChildren, type ReactNode } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { AppText, Banner, Button, EmptyState, IconButton, Pill, Row, SectionLabel, Segmented, Toggle } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { errorMessage, paidFeatureRefusal, showPaidFeatureRefusal } from '../../lib/errors';
import { radius, sans, useTheme } from '../../theme/tokens';
import { useResource } from '../../workflow/hooks';
import { Bar, Intro, Page } from '../more/Page';
import { useRemote } from '../more/useRemote';
import { addReviewerPatch, codeReviewPatchBody, codeReviewSettingsOf, lensStatRows, removeReviewerPatch, reviewerProblems, reviewerRows,
  reviewersBadge } from './model';
import { ReviewerPicker } from './ReviewerPicker';

const PRESET_OPTIONS = CODE_REVIEW_PRESETS.map((preset) => ({ value: preset, label: CODE_REVIEW_PRESET_LABELS[preset] }));
const SEVERITY_OPTIONS = CODE_REVIEW_SEVERITY_ORDER.map((severity) => ({ value: severity, label: CODE_REVIEW_SEVERITY_LABELS[severity] }));
const REPO_ICON = { ios: 'folder', android: 'folder' } as const;
const TALYN_ICON = { ios: 'sparkles', android: 'auto_awesome' } as const;

/**
 * Code review's settings for the workspace, through the same
 * `workspaces.update` web uses. Each change saves at once, like web
 * `CodeReviewSettingsCard`. Turning automatic reviews on without a paid plan
 * is a 402 that offers Plan and credits.
 */
export function CodeReviewSettingsScreen() {
  const workspaceId = useWorkspace().selected;
  const offline = useNetwork() === 'offline';
  const workspace = useResource<Workspace>('workspace', '', Boolean(workspaceId));
  // Context, not a control: a failed read shows nothing and the settings still work.
  const lenses = useRemote<CodeReviewLensStat[]>(workspaceId ? `code-review-lenses:${workspaceId}` : null,
    async () => (await codeReviews.lenses(workspaceId ?? '')).lenses);
  const [pending, setPending] = useState<CodeReviewSettings>({});
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const current = workspaceId && workspace.data?.id === workspaceId ? workspace.data : null;

  if (!workspaceId) return <Page><EmptyState title="No workspace selected" detail="Choose a workspace to change its code review settings." /></Page>;
  if (!current) {
    return <Page><StateNotice resource={workspace} offline={offline} refresh={() => { void workspace.refresh(); }} /></Page>;
  }

  const settings = codeReviewSettingsOf(current.settings?.codeReview, pending);
  const disabled = saving || offline;
  const problems = reviewerProblems(settings);
  const stats = lensStatRows(lenses.data ?? [], settings.customReviewers);

  const save = async (patch: CodeReviewSettings, what: string) => {
    if (saving) return;
    setPending((prev) => ({ ...prev, ...patch }));
    setSaving(true);
    try {
      await workspaces.update(workspaceId, codeReviewPatchBody(patch));
      await workspace.refresh();
    } catch (error) {
      const refusal = paidFeatureRefusal(error);
      if (refusal) showPaidFeatureRefusal(refusal);
      else Alert.alert(`Could not change ${what}`, errorMessage(error, 'Please try again.'));
    } finally {
      setPending({});
      setSaving(false);
    }
  };
  const choose = <T extends string>(value: T, now: T, patch: CodeReviewSettings, what: string) => {
    if (value !== now) void save(patch, what);
  };

  return <Page refreshing={workspace.refreshing} onRefresh={() => { void workspace.refresh(); void lenses.refresh(); }}>
    <Intro>Talyn reads a pull request and puts what it finds in the app.</Intro>
    {offline ? <Banner message="You are offline. Connect to the internet to change these settings." /> : null}

    <Step n={1} title="Review every pull request" badge={settings.autoReview ? 'On' : 'Off'}>
      <ToggleRow title="Review my new pull requests automatically" value={settings.autoReview} disabled={disabled} divider={false}
        detail="Every pull request you open in a watched repository is reviewed as you push. Part of Unlimited."
        onChange={(value) => { void save({ autoReview: value }, 'automatic reviews'); }} />
    </Step>

    <Step n={2} title="How deeply" badge={CODE_REVIEW_PRESET_LABELS[settings.preset]}>
      <View style={styles.block}>
        <Choice disabled={disabled}>
          <Segmented accessibilityLabel="Review depth" options={PRESET_OPTIONS} value={settings.preset}
            onChange={(preset) => choose(preset, settings.preset, { preset }, 'the review depth')} />
        </Choice>
        <AppText variant="meta" tone="muted">{CODE_REVIEW_PRESET_BLURBS[settings.preset]}</AppText>
        <View style={{ gap: 2 }}>
          {codeReviewPresetFacts(settings.preset).map((fact) => <AppText key={fact} variant="meta" tone="muted">· {fact}</AppText>)}
        </View>
        {stats.length ? <View style={styles.stats}>
          <AppText variant="meta" style={sans(600)}>How each reviewer has done here</AppText>
          <AppText variant="caption" tone="muted">Findings raised, and how many survived the checking pass.</AppText>
          {stats.map((stat) => <View key={stat.lens} style={{ gap: 4 }}>
            <View style={styles.statLine}>
              <AppText variant="meta" tone="muted" numberOfLines={1} style={{ flex: 1 }}>{stat.label}</AppText>
              <AppText variant="meta" tone="muted">{stat.text}</AppText>
            </View>
            <Bar percent={stat.percent} label={`${stat.label}: ${stat.text}`} />
          </View>)}
        </View> : null}
      </View>
    </Step>

    <Step n={3} title="Who reviews" badge={reviewersBadge(settings.builtInReviewers, settings.customReviewers.length)}>
      <ToggleRow title="Talyn's reviewers" value={settings.builtInReviewers} disabled={disabled || problems.off !== null}
        detail="Logic, Security, Reliability and the others for the depth you choose."
        hint={problems.off ? 'To turn these off, add a reviewer of your own first.' : undefined}
        onChange={(value) => {
          // The rule again, not only the disabled switch: never send a save the server refuses.
          if (!value && problems.off) return;
          void save({ builtInReviewers: value }, "Talyn's reviewers");
        }} />
      <Reviewers reviewers={settings.customReviewers} disabled={disabled} removeLastProblem={problems.removeLast}
        onAdd={() => setPicking(true)}
        onRemove={(skillKey) => { void save(removeReviewerPatch(settings.customReviewers, skillKey), 'your reviewers'); }} />
    </Step>

    <Step n={4} title="What is worth your attention" badge={`${CODE_REVIEW_SEVERITY_LABELS[settings.reportingBar]} and above`}>
      <View style={styles.block}>
        <Choice disabled={disabled}>
          <Segmented accessibilityLabel="What the list shows" options={SEVERITY_OPTIONS} value={settings.reportingBar}
            onChange={(reportingBar) => choose(reportingBar, settings.reportingBar, { reportingBar }, 'what the list shows')} />
        </Choice>
        <AppText variant="meta" tone="muted">
          The further right, the fewer findings reach the list and the more each one matters. Anything below the bar is still found
          and still readable at the foot of the list. It just does not count towards the badge.
        </AppText>
      </View>
    </Step>

    <Step n={5} title="Fix findings for me" badge={settings.autoFix ? 'On' : 'Off'}>
      <ToggleRow title="Fix findings without asking" value={settings.autoFix} disabled={disabled} divider={false}
        detail="The only setting here that pushes a commit with nobody watching. It touches only findings that survived the checking pass and whose location was confirmed."
        onChange={(value) => { void save({ autoFix: value }, 'automatic fixing'); }} />
    </Step>

    {settings.autoFix ? <Step n={6} title="Which findings it may fix" badge={`${CODE_REVIEW_SEVERITY_LABELS[settings.autoFixSeverity]} and above`}>
      <View style={styles.block}>
        <Choice disabled={disabled}>
          <Segmented accessibilityLabel="What auto-fix may touch" options={SEVERITY_OPTIONS} value={settings.autoFixSeverity}
            onChange={(autoFixSeverity: CodeReviewSeverity) => choose(autoFixSeverity, settings.autoFixSeverity, { autoFixSeverity }, 'what auto-fix may touch')} />
        </Choice>
        <AppText variant="meta" tone="muted">Blockers only is the default. A review that raises six things is not usually six things worth a commit.</AppText>
      </View>
    </Step> : null}

    <View style={{ gap: 6 }}>
      <SectionLabel title="On GitHub" />
      <Surface>
        <ToggleRow title="Post a summary comment after a fix" value={settings.fixSummaryComment} disabled={disabled}
          detail="One short comment saying what was fixed and what was not, so the pull request's other readers know why the branch moved."
          onChange={(value) => { void save({ fixSummaryComment: value }, 'the summary comment'); }} />
        <ToggleRow title="Post blockers as inline comments" value={settings.inlineComments} disabled={disabled} divider={false}
          detail="The one setting that can make Talyn look like every other review bot. Only blockers are posted, and never for a review nobody asked for."
          onChange={(value) => { void save({ inlineComments: value }, 'inline comments'); }} />
      </Surface>
      <AppText variant="meta" tone="muted" style={{ paddingHorizontal: 4 }}>Findings live in Talyn. These two are the exceptions.</AppText>
    </View>

    <ReviewerPicker visible={picking} workspaceId={workspaceId} added={settings.customReviewers} onClose={() => setPicking(false)}
      onPick={(skill) => { void save(addReviewerPatch(settings.customReviewers, skill), 'your reviewers'); }} />
  </Page>;
}

/** One numbered step. The order is the point: each answer raises the next question. */
function Step({ n, title, badge, children }: PropsWithChildren<{ n: number; title: string; badge: string }>) {
  return <View style={{ gap: 6 }}>
    <SectionLabel title={`${n}. ${title}`} trailing={<Pill label={badge} />} />
    <Surface>{children}</Surface>
  </View>;
}

function Surface({ children }: PropsWithChildren) {
  const c = useTheme();
  return <View style={[styles.surface, { backgroundColor: c.paper, borderColor: c.border }]}>{children}</View>;
}

/** A segmented choice that ignores taps while a save runs or the app is offline. */
function Choice({ disabled, children }: PropsWithChildren<{ disabled: boolean }>) {
  return <View pointerEvents={disabled ? 'none' : 'auto'} accessibilityState={{ disabled }} style={{ opacity: disabled ? 0.45 : 1 }}>{children}</View>;
}

function ToggleRow({ title, detail, hint, value, disabled, divider = true, onChange }: {
  title: string; detail: string; hint?: string; value: boolean; disabled: boolean; divider?: boolean; onChange(value: boolean): void;
}) {
  return <Row title={title} titleLines={3} divider={divider}
    subtitle={<View style={{ gap: 4 }}>
      <AppText variant="meta" tone="muted">{detail}</AppText>
      {hint ? <AppText variant="meta" tone="warning">{hint}</AppText> : null}
    </View>}
    trailing={<Toggle accessibilityLabel={title} value={value} disabled={disabled} onValueChange={onChange} />} />;
}

function Reviewers({ reviewers, disabled, removeLastProblem, onAdd, onRemove }: {
  reviewers: readonly CodeReviewCustomReviewer[]; disabled: boolean; removeLastProblem: string | null; onAdd(): void; onRemove(skillKey: string): void;
}) {
  const c = useTheme();
  const rows = reviewerRows(reviewers);
  const note = (text: ReactNode) => <AppText variant="meta" tone="muted">{text}</AppText>;
  return <View style={styles.reviewers}>
    <View style={styles.statLine}>
      <AppText variant="rowTitle" style={{ flex: 1 }}>Your reviewers</AppText>
      <Button title="Add reviewer" size="sm" variant="secondary" icon={{ ios: 'plus', android: 'add' }} disabled={disabled} onPress={onAdd} />
    </View>
    {rows.length === 0 ? note('None yet. Add a skill from a repository or from Talyn, and it reads every review as one more reviewer.') : null}
    {rows.map((row) => <View key={row.skillKey} style={[styles.reviewer, { borderColor: c.border }]}>
      <SymbolView name={row.repo ? REPO_ICON : TALYN_ICON} size={15} tintColor={c.muted} />
      <View style={{ flex: 1, gap: 2 }}>
        <AppText variant="meta" numberOfLines={1} style={sans(600)}>{row.name}</AppText>
        <AppText variant="caption" tone="muted" numberOfLines={1}>{row.source}</AppText>
        {row.scope ? <AppText variant="caption" tone="muted">{row.scope}</AppText> : null}
      </View>
      <IconButton label={`Remove ${row.name}`} symbol={{ ios: 'xmark', android: 'close' }} size={15} tone="muted"
        disabled={disabled || removeLastProblem !== null} onPress={() => onRemove(row.skillKey)} />
    </View>)}
    {removeLastProblem ? note("This is your only reviewer. Turn on Talyn's reviewers before you remove it.") : null}
    {note('Each reviewer is one agent run per review. A large pull request costs more, because Talyn splits it into parts and each reviewer reads each part.')}
  </View>;
}

const styles = StyleSheet.create({
  surface: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, paddingHorizontal: 12, overflow: 'hidden' },
  block: { gap: 10, paddingVertical: 12, paddingHorizontal: 4 },
  stats: { gap: 8, paddingTop: 4 },
  statLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  reviewers: { gap: 8, paddingVertical: 12, paddingHorizontal: 4 },
  reviewer: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md,
    paddingVertical: 8, paddingLeft: 10, paddingRight: 2 },
});
