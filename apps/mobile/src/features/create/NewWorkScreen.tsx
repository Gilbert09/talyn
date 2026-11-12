import { spaces, workbenches, workspaces as workspaceApi, type PRRow, type WatchedRepo } from '@talyn/client/native';
import type { SpaceRepository, Workbench, WorkbenchAgent, WorkbenchReadiness, Workspace } from '@talyn/shared';
import { SymbolView } from 'expo-symbols';
import { useRouter } from 'expo-router';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useAuth, useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { PickerSheet, type PickerSection } from '../../components/PickerSheet';
import { ScreenContainer } from '../../components/ScreenContainer';
import { AppText, Banner, Button, EmptyState, Spinner, useToast, type Symbol } from '../../components/UI';
import { openExternal } from '../../components/Workflow';
import { trackEvent } from '../../lib/analytics';
import { boxRefusal, errorMessage, showBoxRefusal } from '../../lib/errors';
import { featureOffered, useFeatures } from '../../lib/features';
import { useFleetModelCatalog } from '../../lib/fleetModelCatalog';
import { useKeyboardInset } from '../../lib/keyboard';
import { sessionRoute, threadRoute } from '../../navigation/routes';
import { display, mono, radius, sans, type, useTheme } from '../../theme/tokens';
import { useLocal, useResource } from '../../workflow/hooks';
import { useRemote } from '../more/useRemote';
import { WEB_APP_URL } from '../settings/about';
import { SpaceTile } from '../spaces/Avatars';
import { chatActions } from '../chat/actions';
import { ComposerImages } from '../chat/AttachmentViews';
import { writeImageDrafts } from '../chat/attachmentDrafts';
import { buildMessageInput, type ImageDraft } from '../chat/attachments';
import { showImagePicker } from '../chat/imagePicker';
import { useActiveContext } from '../spaces/context';
import { ConnectAgentSheet } from '../agents/connect/ConnectAgentSheet';
import { activePullRequest, agentForModel, blockedReason, branchSuggestions, chipLabel, composerChips, CONNECT_ACTION, connectNotice, createInput, defaultRepositoryId,
  effectiveBranch, filterBranches, filterRepositories, internetMessage, lastRepositoryKey, loadLastRepository, MODES, modelFor, modelSections, modelsFor, PLACEHOLDER,
  pullRequestChoices, pullRequestSource, rememberRepository, sandboxChoice, sendState, usableAgent, type ChipState, type ComposerChip, type NewWorkForm,
  type NewWorkMode, type NewWorkPullRequest } from './model';
import { addsRepositoryNote, spaceBlockedReason, spaceCreateBody, spacePlaceholder, spaceRepositories } from './space';
import { useInlineImages } from './useInlineImages';

type SheetKind = 'mode' | 'repository' | 'branch' | 'model';

const MODE_ICON: Record<NewWorkMode, Symbol> = {
  session: { ios: 'chevron.left.forwardslash.chevron.right', android: 'code' },
  thread: { ios: 'square.stack.3d.up', android: 'layers' },
};
const CHIP_ICON: Record<Exclude<ComposerChip, 'mode'>, Symbol> = {
  repository: { ios: 'folder', android: 'folder' },
  branch: { ios: 'arrow.triangle.branch', android: 'call_split' },
  internet: { ios: 'globe', android: 'language' },
  model: { ios: 'sparkles', android: 'auto_awesome' },
};
// About eight lines of body text, then the field scrolls.
const PROMPT_MAX_HEIGHT = 8 * 22 + 20;

/**
 * Start a session or a thread, like web `NewWorkbenchPage`: a calm page with
 * one composer at the bottom. Repository, branch and internet sit in a row
 * above it, and the mode and model sit inside it. Each opens a sheet. Works as
 * the home screen (`presentation="home"`) and as a pushed route. After a start
 * a route replaces itself and home pushes.
 */
export function NewWorkScreen({ initialMode = 'session', initialRepositoryId, initialPullRequestId, presentation = 'route' }: {
  initialMode?: NewWorkMode; initialRepositoryId?: string; initialPullRequestId?: string; presentation?: 'home' | 'route';
}) {
  const { workflow, workspace: workspaces } = useMobileRuntime();
  const router = useRouter();
  const c = useTheme();
  const offline = useNetwork() === 'offline';
  const features = useFeatures();
  // Subscribes, so the model picker renders again when the backend's catalogue arrives.
  useFleetModelCatalog();
  const offered = featureOffered(features, 'workbenches');
  const repositories = useResource<WatchedRepo[]>('repositories', '', offered);
  const readiness = useResource<WorkbenchReadiness>('readiness', '', offered);
  const workspace = useResource<Workspace>('workspace', '', offered);
  const keyboard = useKeyboardInset();
  const toast = useToast();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const android = Platform.OS === 'android';
  const workspaceId = workflow.getScope()?.workspace ?? '';
  const user = useAuth().user?.id ?? '';
  const draftKey = 'new:prompt';
  // In a space, new work goes through the space and runs in my home workspace for its team, like web.
  const place = useActiveContext();
  const inSpace = place.active;
  const spaceId = inSpace?.space.id ?? null;
  const home = inSpace?.team.homeWorkspaceId ?? null;
  const remoteHome = home && home !== workspaceId ? home : null;
  const spaceRepos = useRemote<SpaceRepository[]>(offered && spaceId ? `space-repositories:${spaceId}` : null, () => spaces.repositories(spaceId ?? ''));
  const homeReadiness = useRemote<WorkbenchReadiness>(offered && remoteHome ? `readiness:${remoteHome}` : null,
    () => workbenches.readiness(remoteHome ?? ''));
  const homeWorkspace = useRemote<Workspace>(offered && remoteHome ? `workspace:${remoteHome}` : null, () => workspaceApi.get(remoteHome ?? ''));
  const readinessSource = remoteHome ? homeReadiness : readiness;
  const settingsSource = remoteHome ? homeWorkspace.data : workspace.data;
  const repoKey = lastRepositoryKey(user, spaceId ? `space:${spaceId}` : workspaceId);
  const prompt = useLocal(draftKey).draft;
  // Web's space composer takes no images, so a space start takes none either.
  const images = useInlineImages(draftKey);
  const attached = inSpace ? [] : images.drafts;

  const [mode, setMode] = useState<NewWorkMode>(initialMode);
  const [repositoryId, setRepositoryId] = useState('');
  const [wantedAgent, setWantedAgent] = useState<WorkbenchAgent>('claude');
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const [baseBranch, setBaseBranch] = useState('');
  const [pullRequest, setPullRequest] = useState<NewWorkPullRequest | null>(null);
  const [internetAccess, setInternetAccess] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [connectAgent, setConnectAgent] = useState<WorkbenchAgent | null>(null);
  const [repoQuery, setRepoQuery] = useState('');
  useEffect(() => { setMode(initialMode); }, [initialMode]);
  // A pull request the route asks to start from. It applies once its row has loaded.
  const [wantedPr, setWantedPr] = useState(initialPullRequestId ?? null);
  useEffect(() => { setWantedPr(initialPullRequestId ?? null); }, [initialPullRequestId]);
  // Open pull requests fill the "Start from" sheet, so they load while it is open or a pull request is wanted.
  const openPrs = useResource<PRRow[]>('attention', '', offered && (sheet === 'branch' || Boolean(wantedPr)));

  const repos = useMemo(() => spaceId ? spaceRepositories(spaceId, spaceRepos.data) : repositories.data ?? [],
    [spaceId, spaceRepos.data, repositories.data]);
  const reposStatus = spaceId ? spaceRepos.status : repositories.status;
  // The repository last started here, saved on the device. It loads after the first draw; a pick made before that wins.
  const [saved, setSaved] = useState<{ key: string; id: string | null } | null>(null);
  const pickedFor = useRef<string | null>(null);
  // A repository the route asks for wins over the saved one, once the repositories have loaded.
  const [wantedRepo, setWantedRepo] = useState(initialRepositoryId ?? null);
  useEffect(() => { setWantedRepo(initialRepositoryId ?? null); }, [initialRepositoryId]);
  useEffect(() => {
    let live = true;
    void loadLastRepository(repoKey).then((id) => { if (live) setSaved({ key: repoKey, id }); });
    return () => { live = false; };
  }, [repoKey]);
  useEffect(() => {
    if (wantedRepo && repos.some((repo) => repo.id === wantedRepo)) {
      setWantedRepo(null);
      pickedFor.current = repoKey;
      if (wantedRepo !== repositoryId) { setRepositoryId(wantedRepo); setBaseBranch(''); }
      return;
    }
    const last = saved?.key === repoKey && pickedFor.current !== repoKey ? saved.id : null;
    if (last && last !== repositoryId && repos.some((repo) => repo.id === last)) { setRepositoryId(last); setBaseBranch(''); return; }
    if (!repos.some((repo) => repo.id === repositoryId)) setRepositoryId(defaultRepositoryId(repoKey, repos));
  }, [repos, repositoryId, repoKey, saved, wantedRepo]);
  // A space session takes no base branch or pull request, like web, so a wanted pull request applies outside spaces only.
  useEffect(() => {
    if (!wantedPr || inSpace) return;
    const row = openPrs.data?.find((item) => item.id === wantedPr) ?? workflow.findPr(wantedPr);
    if (!row) return;
    setWantedPr(null);
    if (row.state !== 'open') return;
    setMode('session');
    setPullRequest(pullRequestSource(row));
    setBaseBranch('');
    setWantedRepo(row.repositoryId);
  }, [wantedPr, inSpace, openPrs.data, workflow]);
  const repository = repos.find((repo) => repo.id === repositoryId) ?? null;
  // A failed readiness read is reported like web: the server or the connection, not the agents.
  const sandbox = readinessSource.data?.sandbox ?? (readinessSource.status === 'error' || readinessSource.status === 'offline' || offline
    ? { ok: false, reasons: [{ code: 'unreachable', message: offline ? 'You are offline' : 'Talyn’s server is not responding' }],
      agents: { claude: { ok: false }, codex: { ok: false } } } as WorkbenchReadiness['sandbox'] : null);
  const agent = usableAgent(sandbox, wantedAgent);
  const model = pickedModel && modelsFor(agent).some((item) => item.id === pickedModel) ? pickedModel : modelFor(settingsSource?.settings, agent);
  const startFrom = inSpace ? null : activePullRequest(pullRequest, repository);
  const form: NewWorkForm = { mode, prompt, repository, agent, model, baseBranch, internetAccess, pullRequest: startFrom };
  const blocked = inSpace ? spaceBlockedReason(form, inSpace.team, sandbox, offline) : blockedReason(form, sandbox, offline) ?? images.block;
  const send = sendState(blocked, busy, workspaceId);
  const sandboxOk = sandboxChoice(sandbox);
  const connect = connectNotice(sandbox, agent);
  const unreachable = sandbox?.reasons[0]?.code === 'unreachable';
  const branch = effectiveBranch(baseBranch, repository);
  const chipState: ChipState = { mode, repository, repositoriesLoading: reposStatus !== 'ready' && !repos.length,
    branch, pullRequest: startFrom, internetAccess, agent, model };
  const chips = composerChips(mode, repository, Boolean(inSpace));
  const addsNote = inSpace && home ? addsRepositoryNote(mode, repository?.fullName, settingsSource) : null;

  const start = async () => {
    if (!send.enabled) return;
    setBusy(true); setError(null);
    try {
      const open = (id: string) => {
        const href = mode === 'thread' ? threadRoute(id) : sessionRoute(id);
        if (presentation === 'route') router.replace(href); else router.push(href);
      };
      if (inSpace) {
        const created = await spaces.createSession(inSpace.space.id, spaceCreateBody(form));
        trackCreated(created.workbench, form);
        if (mode === 'session' && repository) rememberRepository(repoKey, repository.id);
        workflow.updateLocal(draftKey, { draft: '' });
        // The detail screens read the selected workspace, so a session in another of mine switches to it first.
        if (created.workspaceId === workspaceId) { workflow.applyWorkbench(created.workbench); open(created.workbench.id); }
        else {
          await workspaces.select(created.workspaceId);
          if (workspaces.getSnapshot().selected === created.workspaceId) open(created.workbench.id);
          else toast.show(mode === 'thread' ? 'Thread started.' : 'Session started.');
        }
        return;
      }
      const withImages = attached.length > 0;
      const item = await workflow.createWorkbench(createInput(form, workspaceId, withImages));
      trackCreated(item, form, withImages);
      if (mode === 'session' && repository) rememberRepository(repoKey, repository.id);
      // When the first message could not go to the new chat, the text and images stay here.
      const kept = withImages && !(await sendFirstMessage(item, form, attached));
      if (!kept) { workflow.updateLocal(draftKey, { draft: '' }); images.clear(); }
      setBaseBranch('');
      setPullRequest(null);
      open(item.id);
    } catch (failure) {
      const refusal = boxRefusal(failure);
      if (refusal) showBoxRefusal(refusal, mode === 'thread' ? 'thread_create' : 'session_create');
      setError(refusal?.message ?? errorMessage(failure, mode === 'thread' ? 'Could not create the thread.' : 'Could not create the session.'));
    } finally { setBusy(false); }
  };

  /**
   * Like web: a first message with images goes after the create. When it fails, the new chat's composer keeps it.
   * False when there is no chat to keep it in.
   */
  const sendFirstMessage = async (item: Workbench, sent: NewWorkForm, drafts: ImageDraft[]): Promise<boolean> => {
    const input = buildMessageInput(sent.prompt.trim(), drafts);
    let chatId = item.chats?.[0]?.id ?? null;
    try {
      chatId ??= (await workbenches.createChat(item.id, { model: sent.model })).id;
      const ack = await chatActions.send(chatId, input);
      trackEvent('session_message_sent', { queued: ack.queued, plan_mode: false, model_id: sent.model, attachments_count: input.attachments?.length ?? 0 });
      void workflow.load('workbench', item.id);
      return true;
    } catch (failure) {
      const reason = errorMessage(failure, 'The message did not send.');
      if (!chatId) {
        Alert.alert('The first message did not send', `${reason} The ${sent.mode} started without it. Your text and images are still on this page.`);
        return false;
      }
      workflow.updateLocal(chatId, { draft: sent.prompt.trim() });
      writeImageDrafts(chatId, drafts);
      Alert.alert('The first message did not send', `${reason} Your text and images are in the new chat. Send them again from there.`);
      return true;
    }
  };

  const openSheet = (kind: SheetKind) => { Keyboard.dismiss(); setSheet(kind); };
  const closeSheet = () => { setSheet(null); setRepoQuery(''); };
  const openConnect = (target: WorkbenchAgent) => { Keyboard.dismiss(); setConnectAgent(target); };
  const toggleInternet = () => {
    const next = !internetAccess;
    setInternetAccess(next);
    toast.show(internetMessage(next));
  };

  if (features === null || place.context.kind === 'pending') return <ScreenContainer topInset={presentation === 'home'}><View style={styles.center}><Spinner /></View></ScreenContainer>;
  if (!offered) return <ScreenContainer topInset={presentation === 'home'}>
    <EmptyState title="Sessions are not available on this account." />
  </ScreenContainer>;

  const noRepositories = mode === 'session' && reposStatus === 'ready' && !repos.length;
  const notices = <>
    {error ? <Banner tone="destructive" message={error} /> : null}
    {connect ? <Banner tone="information" message={connect.message} action={offline ? undefined : connect.action}
      onAction={() => openConnect(connect.agent)} />
      : !sandboxOk.available && sandbox ? <Banner tone="warning" message={`Sandbox unavailable: ${sandboxOk.reason ?? 'Cloud sessions are unavailable'}`}
        action={unreachable ? (offline ? undefined : 'Retry') : 'Open web'}
        onAction={unreachable ? () => { void readinessSource.refresh(); } : () => openExternal(WEB_APP_URL)} /> : null}
    {noRepositories ? <Banner tone="information" message={inSpace
      ? 'This space has no repositories yet. Add one in Talyn on the web. A thread needs no repository.'
      : 'Add a repository in Talyn on the web to start a session. A thread needs no repository.'}
      action="Open web" onAction={() => openExternal(WEB_APP_URL)} /> : null}
    {addsNote ? <AppText variant="meta" tone="muted" style={styles.note}>{addsNote}</AppText> : null}
  </>;

  const chip = (kind: ComposerChip) => {
    const label = chipLabel(kind, chipState);
    if (kind === 'internet') return <ContextChip key={kind} icon={CHIP_ICON.internet} label={label.text} accessibilityLabel={label.accessibilityLabel}
      active={internetAccess} role="switch" checked={internetAccess} disabled={busy} onPress={toggleInternet} />;
    if (kind === 'mode') return <Chip key={kind} icon={MODE_ICON[mode]} label={label.text} accessibilityLabel={label.accessibilityLabel}
      disabled={busy} onPress={() => openSheet('mode')} />;
    if (kind === 'repository') return <ContextChip key={kind} icon={CHIP_ICON.repository} label={label.text} accessibilityLabel={label.accessibilityLabel}
      maxWidth={200} disabled={busy || (repositories.status !== 'ready' && !repos.length)} onPress={() => openSheet('repository')} />;
    if (kind === 'branch') return <ContextChip key={kind} icon={CHIP_ICON.branch} label={label.text} accessibilityLabel={label.accessibilityLabel}
      maxWidth={140} mono disabled={busy} onPress={() => openSheet('branch')} />;
    return <Chip key={kind} icon={CHIP_ICON.model} label={label.text} accessibilityLabel={label.accessibilityLabel} chevron
      disabled={busy} onPress={() => openSheet('model')} />;
  };

  return <ScreenContainer topInset={presentation === 'home'}>
    <KeyboardAvoidingView style={[styles.page, android && { paddingBottom: keyboard.inset }]}
      behavior={android ? undefined : 'padding'} keyboardVerticalOffset={presentation === 'route' ? headerHeight : 0}>
      <Pressable accessible={false} onPress={Keyboard.dismiss} style={styles.greeting}>
        <Text accessibilityRole="header" style={[styles.heading, { color: c.text }]}>What do you want to build?</Text>
        {inSpace ? <View accessible accessibilityLabel={`In ${inSpace.space.name}`} style={styles.inSpace}>
          <SpaceTile name={inSpace.space.name} color={inSpace.space.color} image={inSpace.space.image} size={14} />
          <Text numberOfLines={1} style={[styles.inSpaceText, { color: c.muted }]}>In {inSpace.space.name}</Text>
        </View> : null}
        {toast.element}
      </Pressable>
      <View style={styles.dock}>
        {notices}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled"
          style={styles.contextScroll} contentContainerStyle={styles.contextRow}>
          {chips.context.map(chip)}
        </ScrollView>
        <View style={[styles.card, { backgroundColor: c.elevated, borderColor: focused ? c.primary : c.border, opacity: busy ? 0.85 : 1 }]}>
          {attached.length ? <View style={styles.images}>
            <ComposerImages drafts={attached} errors={[]} onRemove={images.remove} onRetry={images.retry} onDismissError={() => undefined} />
          </View> : null}
          <TextInput accessibilityLabel={mode === 'thread' ? 'What to get done' : 'Task'} multiline value={prompt} editable={!busy}
            placeholder={inSpace ? spacePlaceholder(mode, inSpace.space.name) : PLACEHOLDER[mode]} placeholderTextColor={c.muted} selectionColor={c.primary}
            onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            onChangeText={(text) => { workflow.updateLocal(draftKey, { draft: text }); if (error) setError(null); }}
            style={[styles.prompt, { color: c.text }]} />
          <View style={styles.controls}>
            {inSpace ? null : <Pressable accessibilityRole="button" accessibilityLabel="Attach an image" accessibilityState={{ disabled: busy }}
              disabled={busy} hitSlop={6} onPress={() => { Keyboard.dismiss(); showImagePicker(images.add); }}
              style={({ pressed }) => [styles.attach, { borderColor: c.border, backgroundColor: pressed ? c.surface : 'transparent', opacity: busy ? 0.5 : 1 }]}>
              <SymbolView name={{ ios: 'plus', android: 'add' }} size={16} tintColor={c.muted} />
            </Pressable>}
            {chip('mode')}
            <View style={styles.spacer} />
            {chip('model')}
            <SendButton enabled={send.enabled} busy={busy} hint={send.hint} label={mode === 'thread' ? 'Start thread' : 'Start session'}
              onPress={() => { void start(); }} />
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>

    <PickerSheet visible={sheet === 'mode'} title="Start" onClose={closeSheet}
      sections={[{ key: 'modes', items: MODES.map((option) => ({ key: option.value, label: option.label, detail: option.detail,
        icon: MODE_ICON[option.value], selected: option.value === mode, onPress: () => { setMode(option.value); setError(null); } })) }]} />

    <PickerSheet visible={sheet === 'repository'} title="Repository" onClose={closeSheet}
      search={repos.length > 6 ? { value: repoQuery, onChange: setRepoQuery, placeholder: 'Find a repository' } : undefined}
      sections={[{ key: 'repositories', items: filterRepositories(repos, repoQuery).map((repo) => ({ key: repo.id, label: repo.fullName,
        selected: repo.id === repositoryId, onPress: () => { pickedFor.current = repoKey; setRepositoryId(repo.id); setBaseBranch(''); setPullRequest(null); } })) }]}
      empty={repos.length ? <EmptyState title="No repository matches." />
        : <EmptyState title="No repositories yet." detail="Add repositories in Talyn on the web.">
          <Button variant="quiet" size="sm" title="Open web" onPress={() => openExternal(WEB_APP_URL)} />
        </EmptyState>} />

    <BranchSheet visible={sheet === 'branch'} onClose={closeSheet} repository={repository} value={baseBranch}
      onChange={(value) => { setBaseBranch(value); setPullRequest(null); }} rows={openPrs.data} loading={openPrs.status === 'loading'}
      pullRequest={startFrom} onPickPullRequest={(row) => { setPullRequest(pullRequestSource(row)); setBaseBranch(''); closeSheet(); }} />

    <PickerSheet visible={sheet === 'model'} title="Model" onClose={closeSheet} sections={modelSections(sandbox, agent).map((section): PickerSection => ({
      key: section.agent, title: section.title, note: section.note,
      action: section.connect ? { label: CONNECT_ACTION[section.connect], onPress: () => {
        closeSheet();
        // Two native modals cannot swap in one frame on iOS, so the connect sheet opens once the model sheet has gone.
        setTimeout(() => openConnect(section.agent), 350);
      } } : undefined,
      items: section.models.map((item) => ({ key: item.id, label: item.label, detail: item.blurb,
        selected: section.agent === agent && item.id === model,
        onPress: () => { setWantedAgent(agentForModel(item.id) ?? section.agent); setPickedModel(item.id); } })),
    }))} />

    <ConnectAgentSheet visible={connectAgent !== null} agent={connectAgent ?? undefined} workspaceId={remoteHome ?? undefined}
      onClose={() => setConnectAgent(null)} onConnected={() => {
        if (connectAgent) setWantedAgent(connectAgent);
        void readinessSource.refresh();
      }} />
  </ScreenContainer>;
}

/**
 * "Start from": a new branch from a base branch, or an open pull request's
 * branch. Like web's "Create from…", in one sheet.
 */
function BranchSheet({ visible, onClose, repository, value, onChange, rows, loading, pullRequest, onPickPullRequest }: {
  visible: boolean; onClose(): void; repository: WatchedRepo | null; value: string; onChange(value: string): void; rows?: PRRow[];
  loading?: boolean; pullRequest: NewWorkPullRequest | null; onPickPullRequest(row: PRRow): void;
}) {
  const c = useTheme();
  const current = pullRequest ? null : effectiveBranch(value, repository);
  const suggestions = filterBranches(branchSuggestions(repository, rows), value);
  const prs = pullRequestChoices(repository, rows ?? []);
  const pick = (branch: string) => onChange(branch === repository?.defaultBranch ? '' : branch);
  const sections: PickerSection[] = [{ key: 'branches', title: suggestions.length ? 'New branch from' : undefined, items: suggestions.map((branch) => ({
    key: branch, label: branch, mono: true, selected: branch === current,
    detail: branch === repository?.defaultBranch ? 'Default branch' : undefined, onPress: () => pick(branch) })) }];
  if (prs.length) sections.push({ key: 'pull-requests', title: 'Pull requests', items: prs.map((row) => ({
    key: row.id, label: `#${row.number} ${row.summary.title ?? ''}`.trim(), detail: row.summary.headBranch,
    selected: row.id === pullRequest?.id, onPress: () => onPickPullRequest(row) })) });
  else if (loading) sections.push({ key: 'pull-requests', title: 'Pull requests', note: 'Loading pull requests…', items: [] });
  return <PickerSheet visible={visible} title="Start from" onClose={onClose}
    header={<View style={styles.branchField}>
      <TextInput accessibilityLabel="Base branch" value={value} onChangeText={onChange} placeholder={repository?.defaultBranch || 'main'}
        placeholderTextColor={c.muted} selectionColor={c.primary} autoCapitalize="none" autoCorrect={false} spellCheck={false}
        returnKeyType="done" onSubmitEditing={onClose}
        style={[styles.branchInput, { color: c.text, backgroundColor: c.surface }]} />
      <AppText variant="meta" tone="muted">{pullRequest
        ? `The session checks out the branch of pull request #${pullRequest.number}. Type a branch to start a new branch instead.`
        : 'The session starts a new branch from this one. Or pick a pull request to work on its branch.'}</AppText>
    </View>}
    sections={sections} />;
}

/** A control inside the composer card. */
function Chip({ icon, label, accessibilityLabel, onPress, disabled = false, chevron = false }: {
  icon: Symbol; label: string; accessibilityLabel: string; onPress(): void; disabled?: boolean; chevron?: boolean;
}) {
  const c = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} hitSlop={{ top: 6, bottom: 6 }}
    style={({ pressed }) => [styles.chip, { backgroundColor: pressed ? c.surface : 'transparent', borderColor: c.border, opacity: disabled ? 0.5 : 1 }]}>
    <SymbolView name={icon} size={14} tintColor={c.muted} />
    <Text numberOfLines={1} style={[styles.chipText, { color: c.text }]}>{label}</Text>
    {chevron ? <SymbolView name={{ ios: 'chevron.down', android: 'expand_more' }} size={12} tintColor={c.muted} /> : null}
  </Pressable>;
}

/** A small muted text control in the row above the composer. */
function ContextChip({ icon, label, accessibilityLabel, onPress, disabled = false, active = false, mono: code = false, maxWidth,
  role = 'button', checked }: {
  icon: Symbol; label: string; accessibilityLabel: string; onPress(): void; disabled?: boolean; active?: boolean; mono?: boolean;
  maxWidth?: number; role?: 'button' | 'switch'; checked?: boolean;
}) {
  const c = useTheme();
  const color = active ? c.primaryAction : c.muted;
  return <Pressable accessibilityRole={role} accessibilityLabel={accessibilityLabel}
    accessibilityState={{ disabled, ...(role === 'switch' ? { checked } : {}) }} disabled={disabled} onPress={onPress}
    hitSlop={{ top: 8, bottom: 8 }}
    style={({ pressed }) => [styles.contextChip, { maxWidth, backgroundColor: pressed ? c.surface : 'transparent', opacity: disabled ? 0.5 : 1 }]}>
    <SymbolView name={icon} size={13} tintColor={color} />
    <Text numberOfLines={1} ellipsizeMode="tail" style={[code ? styles.contextMono : styles.contextText, { color }]}>{label}</Text>
  </Pressable>;
}

function SendButton({ enabled, busy, hint, label, onPress }: { enabled: boolean; busy: boolean; hint?: string; label: string; onPress(): void }) {
  const c = useTheme();
  const background = enabled || busy ? c.primaryAction : c.surface;
  const foreground = enabled || busy ? c.primaryText : c.muted;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint}
    accessibilityState={{ disabled: !enabled, busy }} disabled={!enabled} onPress={onPress} hitSlop={4}
    style={({ pressed }) => [styles.send, { backgroundColor: background, opacity: pressed ? 0.8 : 1 }]}>
    {busy ? <ActivityIndicator size="small" color={foreground} />
      : <SymbolView name={{ ios: 'arrow.up', android: 'arrow_upward' }} size={18} tintColor={foreground} />}
  </Pressable>;
}


/**
 * Web's create events, with the same names and keys. A prompt without images goes with the create, so it counts as a
 * sent message here. A prompt with images counts when it is sent.
 */
function trackCreated(item: Workbench, form: NewWorkForm, withImages = false) {
  trackEvent('session_created', { kind: item.kind ?? 'session', runtime: item.runtime, repository_id: item.repositoryId ?? null,
    size: item.settings.sandboxSize ?? item.settings.boxSize ?? 'default' });
  if (form.prompt.trim() && !withImages) trackEvent('session_message_sent', { queued: true, plan_mode: false, model_id: form.model, attachments_count: 0 });
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  greeting: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, overflow: 'hidden' },
  heading: { fontSize: 24, lineHeight: 30, letterSpacing: -0.3, textAlign: 'center', ...display(600) },
  inSpace: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, maxWidth: '100%' },
  inSpaceText: { fontSize: 13, lineHeight: 18, ...sans(500), flexShrink: 1 },
  note: { paddingHorizontal: 4 },
  dock: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8, gap: 8, width: '100%', maxWidth: 760, alignSelf: 'center' },
  card: { borderRadius: 16, borderWidth: 1 },
  // Two lines tall from the start, so the first typed line does not resize the field.
  prompt: { ...type.body, minHeight: 64, maxHeight: PROMPT_MAX_HEIGHT, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8,
    textAlignVertical: 'top' },
  images: { paddingHorizontal: 10, paddingTop: 10 },
  attach: { width: 32, height: 32, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 8, paddingRight: 8, paddingBottom: 8 },
  spacer: { flex: 1 },
  contextScroll: { flexGrow: 0 },
  contextRow: { alignItems: 'center', gap: 2, paddingHorizontal: 2 },
  contextChip: { height: 28, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, borderRadius: radius.sm },
  contextText: { fontSize: 13, lineHeight: 18, ...sans(500), flexShrink: 1 },
  contextMono: { fontSize: 12, lineHeight: 18, ...mono(400), flexShrink: 1 },
  chip: { height: 32, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, maxWidth: 170, flexShrink: 1 },
  chipText: { fontSize: 13, lineHeight: 18, ...sans(500), flexShrink: 1 },
  send: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  branchField: { paddingHorizontal: 16, paddingBottom: 8, gap: 6 },
  branchInput: { minHeight: 44, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, ...mono(400) },
});
