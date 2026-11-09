import type { WatchedRepo } from '@talyn/client/native';
import type { WorkbenchAgent, WorkbenchReadiness, Workspace } from '@talyn/shared';
import { useRouter } from 'expo-router';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useContext, useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { ScreenContainer } from '../../components/ScreenContainer';
import { AppText, Banner, BottomBar, Button, EmptyState, Field, Group, Input, Row, Segmented, Spinner, useActionSheet } from '../../components/UI';
import { Heading, openExternal, workflowStyles as styles } from '../../components/Workflow';
import { boxRefusal, errorMessage, showBoxRefusal } from '../../lib/errors';
import { featureOffered, useFeatures } from '../../lib/features';
import { useKeyboardInset } from '../../lib/keyboard';
import { sessionRoute, threadRoute } from '../../navigation/routes';
import { useTheme } from '../../theme/tokens';
import { useLocal, useResource } from '../../workflow/hooks';
import { WEB_APP_URL } from '../settings/about';
import { AGENT_NAMES, AGENTS, agentChoice, blockedReason, createInput, defaultRepositoryId, modelFor, modelLabel, modelsFor,
  rememberRepository, sandboxChoice, usableAgent, type NewWorkForm, type NewWorkMode } from './model';

const MODES = [{ value: 'session', label: 'Session' }, { value: 'thread', label: 'Thread' }] as const;
const PLACEHOLDER: Record<NewWorkMode, string> = {
  session: 'Describe a task. The agent works on a new branch and can open a pull request.',
  thread: 'What do you want to get done? A thread can work across repositories.',
};

/**
 * Start a session or a thread, like web `NewWorkbenchPage`. Works as the home
 * screen (`presentation="home"`) and as a pushed route. After a start it opens
 * the new work: a route replaces itself, the home screen pushes.
 */
export function NewWorkScreen({ initialMode = 'session', presentation = 'route' }: { initialMode?: NewWorkMode; presentation?: 'home' | 'route' }) {
  const { workflow } = useMobileRuntime();
  const router = useRouter();
  const colors = useTheme();
  const offline = useNetwork() === 'offline';
  const features = useFeatures();
  const offered = featureOffered(features, 'workbenches');
  const repositories = useResource<WatchedRepo[]>('repositories', '', offered);
  const readiness = useResource<WorkbenchReadiness>('readiness', '', offered);
  const workspace = useResource<Workspace>('workspace', '', offered);
  const sheet = useActionSheet();
  const keyboard = useKeyboardInset();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const android = Platform.OS === 'android';
  const workspaceId = workflow.getScope()?.workspace ?? '';
  const draftKey = 'new:prompt';
  const prompt = useLocal(draftKey).draft;

  const [mode, setMode] = useState<NewWorkMode>(initialMode);
  const [repositoryId, setRepositoryId] = useState('');
  const [wantedAgent, setWantedAgent] = useState<WorkbenchAgent>('claude');
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const [baseBranch, setBaseBranch] = useState('');
  const [internetAccess, setInternetAccess] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setMode(initialMode); }, [initialMode]);

  const repos = useMemo(() => repositories.data ?? [], [repositories.data]);
  useEffect(() => {
    if (!repos.some((repo) => repo.id === repositoryId)) setRepositoryId(defaultRepositoryId(workspaceId, repos));
  }, [repos, repositoryId, workspaceId]);
  const repository = repos.find((repo) => repo.id === repositoryId) ?? null;
  // A failed readiness read is reported like web: the server or the connection, not the agents.
  const sandbox = readiness.data?.sandbox ?? (readiness.status === 'error' || readiness.status === 'offline' || offline
    ? { ok: false, reasons: [{ code: 'unreachable', message: offline ? 'You are offline' : 'Talyn’s server is not responding' }],
      agents: { claude: { ok: false }, codex: { ok: false } } } as WorkbenchReadiness['sandbox'] : null);
  const agent = usableAgent(sandbox, wantedAgent);
  const model = pickedModel && modelsFor(agent).some((item) => item.id === pickedModel) ? pickedModel : modelFor(workspace.data?.settings, agent);
  const form: NewWorkForm = { mode, prompt, repository, agent, model, baseBranch, internetAccess };
  const blocked = blockedReason(form, sandbox, offline);
  const sandboxOk = sandboxChoice(sandbox);
  const agentOk = agentChoice(sandbox, agent);
  const connect = !sandboxOk.available ? sandboxOk.connect : !agentOk.available ? agentOk.connect : undefined;
  const unreachable = sandbox?.reasons[0]?.code === 'unreachable';

  const start = async () => {
    if (blocked || busy || !workspaceId) return;
    setBusy(true); setError(null);
    try {
      const item = await workflow.createWorkbench(createInput(form, workspaceId));
      if (mode === 'session' && repository) rememberRepository(workspaceId, repository.id);
      workflow.updateLocal(draftKey, { draft: '' });
      setBaseBranch('');
      const href = mode === 'thread' ? threadRoute(item.id) : sessionRoute(item.id);
      if (presentation === 'route') router.replace(href); else router.push(href);
    } catch (failure) {
      const refusal = boxRefusal(failure);
      if (refusal) showBoxRefusal(refusal);
      setError(refusal?.message ?? errorMessage(failure, mode === 'thread' ? 'Could not create the thread.' : 'Could not create the session.'));
    } finally { setBusy(false); }
  };

  const chooseRepository = () => sheet.open({ title: 'Repository', actions: repos.map((repo) => ({
    label: repo.fullName, selected: repo.id === repositoryId, onPress: () => { setRepositoryId(repo.id); setBaseBranch(''); },
  })) });
  const chooseAgent = () => sheet.open({ title: 'Agent', actions: AGENTS.map((value) => {
    const choice = agentChoice(sandbox, value);
    return { label: AGENT_NAMES[value], selected: value === agent, disabled: !choice.available, detail: choice.available ? undefined : choice.reason,
      onPress: () => { setWantedAgent(value); setPickedModel(null); } };
  }) });
  const chooseModel = () => sheet.open({ title: 'Model', actions: modelsFor(agent).map((item) => ({
    label: item.label, detail: item.blurb, selected: item.id === model, onPress: () => setPickedModel(item.id),
  })) });

  if (features === null) return <ScreenContainer topInset={presentation === 'home'}><View style={local.center}><Spinner /></View></ScreenContainer>;
  if (!offered) return <ScreenContainer topInset={presentation === 'home'}>
    <EmptyState title="Sessions are not available on this account." />
  </ScreenContainer>;

  const noRepositories = mode === 'session' && repositories.status === 'ready' && !repos.length;
  return <ScreenContainer topInset={presentation === 'home'}>
    <KeyboardAvoidingView style={[styles.page, android && { paddingBottom: keyboard.inset }]} 
      behavior={android ? undefined : 'padding'} keyboardVerticalOffset={presentation === 'route' ? headerHeight : 0}>
      <ScrollView contentContainerStyle={[styles.content, local.content]} keyboardShouldPersistTaps="handled">
        {presentation === 'home' ? <Heading>What do you want to build?</Heading> : null}
        <Segmented<NewWorkMode> options={MODES} value={mode} onChange={(value) => { setMode(value); setError(null); }} accessibilityLabel="What to start" />
        <Input accessibilityLabel={mode === 'thread' ? 'What to get done' : 'Task'} multiline value={prompt} editable={!busy}
          placeholder={PLACEHOLDER[mode]} style={local.prompt}
          onChangeText={(text) => { workflow.updateLocal(draftKey, { draft: text }); if (error) setError(null); }} />
        {noRepositories ? <Banner tone="information" message="Add a repository in Talyn on the web to start a session. A thread needs no repository."
          action="Open web" onAction={() => openExternal(WEB_APP_URL)} /> : null}
        <Group>
          {mode === 'session' ? <Row title="Repository" onPress={repos.length ? chooseRepository : undefined} chevron={repos.length > 1}
            trailing={<AppText variant="meta" tone="muted" numberOfLines={1} style={local.value}>
              {repository?.fullName ?? (repositories.status === 'ready' ? 'None' : 'Loading')}</AppText>}
            accessibilityLabel={`Repository: ${repository?.fullName ?? 'none'}`} /> : null}
          <Row title="Agent" onPress={chooseAgent} chevron accessibilityLabel={`Agent: ${AGENT_NAMES[agent]}`}
            trailing={<AppText variant="meta" tone="muted" style={local.value}>{AGENT_NAMES[agent]}</AppText>} />
          <Row title="Model" onPress={chooseModel} chevron accessibilityLabel={`Model: ${modelLabel(model)}`}
            trailing={<AppText variant="meta" tone="muted" style={local.value}>{modelLabel(model)}</AppText>} />
          <Row title="Internet access" divider={false} subtitle={internetAccess ? 'The agent can reach the internet.' : 'Repository only.'}
            trailing={<Switch accessibilityLabel="Internet access" value={internetAccess} onValueChange={setInternetAccess}
              trackColor={{ true: colors.primaryAction, false: colors.surface }} />} />
        </Group>
        {mode === 'session' && repository ? <Field label="Base branch">
          <Input accessibilityLabel="Base branch" value={baseBranch} onChangeText={setBaseBranch} autoCapitalize="none" autoCorrect={false}
            placeholder={(repository as WatchedRepo).defaultBranch || 'main'} />
        </Field> : null}
        {error ? <Banner tone="destructive" message={error} /> : null}
        {!sandboxOk.available && sandbox ? <Banner tone="warning" message={`Sandbox unavailable: ${sandboxOk.reason ?? 'Cloud sessions are unavailable'}`}
          action={unreachable ? (offline ? undefined : 'Retry') : 'Open web'}
          onAction={unreachable ? () => { void readiness.refresh(); } : () => openExternal(WEB_APP_URL)} />
          : connect ? <Banner tone="information" message={`${agentOk.reason ?? 'This agent is not connected'}. Connect your Claude or ChatGPT subscription in Talyn on the web, in Settings, Integrations.`}
            action="Open web" onAction={() => openExternal(WEB_APP_URL)} /> : null}
      </ScrollView>
      <BottomBar>
        <View style={{ flex: 1 }}>
          <Button title={mode === 'thread' ? 'Start thread' : 'Start session'} icon={{ ios: 'arrow.up', android: 'arrow_upward' }}
            loading={busy} disabled={Boolean(blocked) || busy} onPress={() => { void start(); }}
            accessibilityLabel={blocked ? `${mode === 'thread' ? 'Start thread' : 'Start session'}. ${blocked}` : undefined} />
        </View>
      </BottomBar>
    </KeyboardAvoidingView>
    {sheet.sheet}
  </ScreenContainer>;
}

const local = StyleSheet.create({
  content: { gap: 14 },
  prompt: { minHeight: 120, maxHeight: 260 },
  value: { maxWidth: 200, textAlign: 'right' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
