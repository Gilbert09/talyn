import { cloudProviders, type CloudProviderInfo } from '@talyn/client/native';
import type { FleetAccountsResponse, FleetAgent } from '@talyn/shared';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';

import { useMobileRuntime, useWorkspace } from '../../../auth/AuthProvider';
import { PickerSheet } from '../../../components/PickerSheet';
import { AppText, Button, Disclosure, Divider, Field, Group, Input, Pill, Row, SectionHeader, Spinner } from '../../../components/UI';
import { trackEvent } from '../../../lib/analytics';
import { mono } from '../../../theme/tokens';
import { useResource } from '../../../workflow/hooks';
import { webUrl } from '../../more/Page';
import { useRemote } from '../../more/useRemote';
import { ApiKeyForm } from './ApiKeyForm';
import { accountErrorMessage, errorText, AGENT_SHORT, agentState, apiKeyLabel, CODEX_SETTINGS_PATH, CODEX_STEPS, connectTarget, FLEET_AGENTS,
  looksLikeClaudeCode, REAUTH_DETAIL, type ConnectTarget } from './model';

export interface ConnectAgentPanelProps {
  /** The agent to connect. Without one the panel first asks which. */
  agent?: FleetAgent;
  /** Called once the agent is connected and the cached state is refreshed. */
  onConnected(): void;
  /** Reconnect this account rather than choosing one. */
  accountId?: string;
  /** Add a new account even when an existing one needs a reconnect. */
  add?: boolean;
  /** The workspace to connect. Defaults to the selected one. */
  workspaceId?: string;
  /** Called when the person picks an agent from the list. */
  onChoose?(agent: FleetAgent): void;
}

const DETAIL: Record<FleetAgent, string> = { claude: 'Use your Claude Pro or Max subscription.', codex: 'Use your ChatGPT subscription.' };

/** The account list, or null on an older backend that has none. */
export async function loadFleetAccounts(workspaceId: string): Promise<FleetAccountsResponse | null> {
  try { return await cloudProviders.fleetAccounts.list(workspaceId); }
  catch (error) { if ((error as { status?: number }).status === 404) return null; throw error; }
}

/**
 * Connect a Talyn Fleet agent in the app, like web `FleetAgentRow` and
 * `FleetAccountsList`. Claude signs in on Anthropic's page and the user pastes
 * back the code it shows. Codex signs in with `codex login`, which needs a
 * computer, so the panel says how and offers an API key. Embeddable, for
 * onboarding; `ConnectAgentSheet` wraps it for everywhere else.
 */
export function ConnectAgentPanel({ agent, onConnected, accountId, add = false, workspaceId, onChoose }: ConnectAgentPanelProps) {
  const { workflow } = useMobileRuntime();
  const selected = useWorkspace().selected ?? '';
  const ws = workspaceId ?? selected;
  const [choice, setChoice] = useState<FleetAgent | null>(null);
  const chosen = agent ?? choice;
  const accounts = useRemote<FleetAccountsResponse | null>(ws ? `fleet-accounts:${ws}` : null, () => loadFleetAccounts(ws));
  const providers = useResource<CloudProviderInfo[]>('providers');
  const fleet = ws === selected ? providers.data?.find((provider) => provider.type === 'selfhosted') : undefined;

  const connected = useCallback(async () => {
    await accounts.refresh();
    // The composer and the agent lists read these, so they change without a restart.
    await Promise.allSettled([workflow.load('providers'), workflow.load('readiness'), workflow.load('workspace')]);
    onConnected();
  }, [accounts, workflow, onConnected]);

  if (!chosen) {
    return <View style={styles.stack}>
      <AppText variant="meta" tone="muted">Use your Claude or ChatGPT subscription.</AppText>
      <Group>
        {FLEET_AGENTS.map((item, index) => {
          const state = agentState(item, accounts.data, fleet);
          return <Row key={item} title={AGENT_SHORT[item]} subtitle={DETAIL[item]} chevron divider={index < FLEET_AGENTS.length - 1}
            accessibilityLabel={`${AGENT_SHORT[item]}: ${state.label}`} onPress={() => { onChoose?.(item); setChoice(item); }}
            trailing={state.connected ? <Pill label={state.label} tone={state.tone} /> : undefined} />;
        })}
      </Group>
    </View>;
  }

  // The target decides which account the sign-in writes, so it waits for the list.
  if (accounts.data === undefined && accounts.status === 'loading') {
    return <View style={styles.loading}><Spinner /><AppText variant="meta" tone="muted">Loading accounts</AppText></View>;
  }
  const target = connectTarget(accounts.data, chosen, { accountId, add });
  const state = agentState(chosen, accounts.data, fleet);
  const reconnecting = Boolean(target && 'accountId' in target
    && accounts.data?.accounts.find((account) => account.id === target.accountId)?.needsReauth) || (!add && !accounts.data && state.reauth);
  return <View style={styles.stack}>
    {!agent ? <View style={{ alignSelf: 'flex-start' }}>
      <Button variant="quiet" size="sm" icon={{ ios: 'chevron.left', android: 'chevron_left' }} title="Choose a different agent"
        onPress={() => setChoice(null)} />
    </View> : null}
    {reconnecting ? <AppText variant="meta" tone="muted">{REAUTH_DETAIL[chosen]}</AppText> : null}
    {chosen === 'claude'
      ? <ClaudeSignIn workspaceId={ws} target={target} reconnecting={reconnecting} onConnected={connected} />
      : <CodexOnComputer connected={state.connected && !state.reauth} onCheck={async () => {
        await accounts.refresh();
        await Promise.allSettled([workflow.load('providers'), workflow.load('readiness')]);
      }} onConnected={onConnected} />}
    {chosen === 'claude'
      ? <Disclosure title="Use an API key instead">
        <ApiKeyForm agent="claude" workspaceId={ws} label={apiKeyLabel(accounts.data, 'claude')} onAdded={() => { void connected(); }} />
      </Disclosure>
      : <>
        <Divider />
        <SectionHeader title="Or use an API key" />
        <ApiKeyForm agent="codex" workspaceId={ws} label={apiKeyLabel(accounts.data, 'codex')} onAdded={() => { void connected(); }} />
      </>}
  </View>;
}

const targetOptions = (target: ConnectTarget) => target && ('accountId' in target ? { accountId: target.accountId } : { label: target.label });

/**
 * Two steps with a browser trip between them. The PKCE verifier stays on the
 * server, so the pasted code is worthless on its own. The server refuses a
 * grant that cannot run a model; its sentence is shown as it is.
 */
function ClaudeSignIn({ workspaceId, target, reconnecting, onConnected }: {
  workspaceId: string; target: ConnectTarget; reconnecting: boolean; onConnected(): Promise<void>;
}) {
  const [step, setStep] = useState<'start' | 'code'>('start');
  const [url, setUrl] = useState<string | null>(null);
  // The account the sign-in was started for. Finishing must name the same one.
  const [started, setStarted] = useState<ConnectTarget>(undefined);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const prefill = useCallback(async () => {
    try {
      if (!(await Clipboard.hasStringAsync())) return;
      const text = await Clipboard.getStringAsync();
      if (mounted.current && looksLikeClaudeCode(text)) setCode((current) => current.trim() ? current : text.trim());
    } catch { /* The clipboard is a convenience; the field still takes a paste. */ }
  }, []);

  // Android returns from the browser without resolving the open, so coming back to the app checks too.
  useEffect(() => {
    if (step !== 'code') return undefined;
    let away = false;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') { away = true; return; }
      if (away) { away = false; void prefill(); }
    });
    return () => subscription.remove();
  }, [step, prefill]);

  const open = async (address: string) => {
    if (!address.startsWith('https://')) throw new Error('The sign-in page address is not valid.');
    await WebBrowser.openBrowserAsync(address);
    await prefill();
  };

  const start = async () => {
    setBusy(true); setError(null);
    trackEvent('cloud_provider_signin_started', { provider: 'selfhosted', agent: 'claude', method: 'claude_oauth' });
    try {
      const result = await cloudProviders.startClaudeSignIn(workspaceId, targetOptions(target));
      setUrl(result.url); setStarted(target); setStep('code');
      setBusy(false);
      await open(result.url);
    } catch (failure) {
      trackEvent('cloud_provider_connect_failed', { provider: 'selfhosted', agent: 'claude', stage: 'start', error: errorText(failure) });
      if (mounted.current) setError(accountErrorMessage(failure, 'Could not start the Claude sign-in.'));
    } finally { if (mounted.current) setBusy(false); }
  };

  const finish = async () => {
    setBusy(true); setError(null);
    try {
      await cloudProviders.completeClaudeSignIn(workspaceId, code.trim(), targetOptions(started));
      trackEvent('cloud_provider_connected', { provider: 'selfhosted', agent: 'claude' });
      setCode('');
      await onConnected();
    } catch (failure) {
      trackEvent('cloud_provider_connect_failed', { provider: 'selfhosted', agent: 'claude', stage: 'finish', error: errorText(failure) });
      if (mounted.current) setError(accountErrorMessage(failure, 'Could not finish the Claude sign-in.'));
    } finally { if (mounted.current) setBusy(false); }
  };

  const paste = async () => {
    try {
      const text = (await Clipboard.getStringAsync()).trim();
      if (text) { setCode(text); setError(null); }
    } catch { setError('Could not read the clipboard. Paste the code into the field.'); }
  };

  if (step === 'start') return <View style={styles.stack}>
    <AppText variant="meta" tone="muted">
      Sign in with your Claude account. Talyn opens Anthropic’s own sign-in page and never sees your password.
    </AppText>
    {error ? <AppText accessibilityRole="alert" variant="meta" tone="destructive">{error}</AppText> : null}
    <Button title={reconnecting ? 'Sign in to Claude again' : 'Sign in with Claude'} loading={busy} disabled={busy || !workspaceId}
      onPress={() => { void start(); }} />
  </View>;

  return <View style={styles.stack}>
    <AppText variant="meta" tone="muted">Approve the request in the browser, then copy the code Anthropic shows you and paste it here.</AppText>
    <Field label="Code from Anthropic">
      <Input accessibilityLabel="Code from Anthropic" value={code} onChangeText={(value) => { setCode(value); setError(null); }}
        placeholder="Paste the code" autoCapitalize="none" autoCorrect={false} spellCheck={false} autoComplete="off"
        importantForAutofill="no" editable={!busy} returnKeyType="done" onSubmitEditing={() => { if (code.trim()) void finish(); }}
        style={styles.code} />
    </Field>
    {error ? <AppText accessibilityRole="alert" variant="meta" tone="destructive">{error}</AppText> : null}
    <View style={styles.actions}>
      <Button size="sm" title="Finish sign-in" loading={busy} disabled={busy || !code.trim()} onPress={() => { void finish(); }} />
      {!code.trim() ? <Button size="sm" variant="secondary" title="Paste" disabled={busy} onPress={() => { void paste(); }} /> : null}
    </View>
    <View style={styles.actions}>
      {url ? <Button size="sm" variant="quiet" title="Open the sign-in page again" disabled={busy}
        onPress={() => { void open(url).catch(() => setError('Could not open the sign-in page.')); }} /> : null}
      <Button size="sm" variant="quiet" title="Back" disabled={busy} onPress={() => { setStep('start'); setCode(''); setError(null); }} />
    </View>
  </View>;
}

/** The ChatGPT sign-in needs `codex login`, so it is finished on a computer. */
function CodexOnComputer({ connected, onCheck, onConnected }: { connected: boolean; onCheck(): Promise<void>; onConnected(): void }) {
  const [copied, setCopied] = useState(false);
  const [checked, setChecked] = useState(false);
  const [checking, setChecking] = useState(false);
  useEffect(() => { if (checked && connected) onConnected(); }, [checked, connected, onConnected]);
  const link = webUrl(CODEX_SETTINGS_PATH);
  return <View style={styles.stack}>
    <SectionHeader title="Finish on your computer" detail="The ChatGPT sign-in uses the Codex command line, so it runs on a computer." />
    <View style={{ gap: 6 }}>
      {CODEX_STEPS.map((text, index) => <View key={text} style={styles.step}>
        <AppText variant="meta" tone="muted" style={styles.stepNumber}>{index + 1}.</AppText>
        <AppText variant="meta" style={{ flex: 1 }}>{text}</AppText>
      </View>)}
    </View>
    <AppText variant="meta" tone="muted">The Talyn desktop app can do this in one click.</AppText>
    {checked && !connected && !checking ? <AppText accessibilityRole="alert" variant="meta" tone="muted">Codex is not connected yet.</AppText> : null}
    <View style={styles.actions}>
      <Button size="sm" variant="secondary" title={copied ? 'Link copied' : 'Copy the link'} accessibilityLabel={`Copy the link ${link}`}
        onPress={() => { void Clipboard.setStringAsync(link).then(() => setCopied(true)).catch(() => undefined); }} />
      <Button size="sm" variant="quiet" title="Check again" loading={checking} disabled={checking}
        onPress={() => { setChecking(true); void onCheck().finally(() => { setChecking(false); setChecked(true); }); }} />
    </View>
  </View>;
}

/**
 * The panel in a bottom sheet, for the Agents page and the composer. It
 * closes itself once the agent is connected.
 */
export function ConnectAgentSheet({ visible, onClose, onConnected, title, ...panel }: Omit<ConnectAgentPanelProps, 'onConnected'> & {
  visible: boolean; onClose(): void; onConnected?(): void; title?: string;
}) {
  const heading = title ?? (panel.agent ? `${panel.accountId ? 'Reconnect' : 'Connect'} ${AGENT_SHORT[panel.agent]}` : 'Connect an agent');
  const done = useCallback(() => { onConnected?.(); onClose(); }, [onConnected, onClose]);
  return <PickerSheet visible={visible} title={heading} onClose={onClose} sections={[]}
    empty={visible ? <View style={styles.sheetBody}><ConnectAgentPanel {...panel} onConnected={done} /></View> : null} />;
}

const styles = StyleSheet.create({
  stack: { gap: 12 },
  loading: { alignItems: 'center', gap: 8, paddingVertical: 24 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  code: { ...mono(400), fontSize: 14 },
  step: { flexDirection: 'row', gap: 6 },
  stepNumber: { minWidth: 16 },
  sheetBody: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 16 },
});
