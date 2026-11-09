import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useNetwork } from '../../auth/AuthProvider';
import { AppText, Banner, Button, Pill } from '../../components/UI';
import { errorMessage } from '../../lib/errors';
import { radius, useTheme } from '../../theme/tokens';
import { openGithubAppFlow, type useGithubConnection } from './githubFlow';
import { GithubInstallStatus } from './GithubInstallStatus';
import { onGithubReturn, takeGithubReturn } from './githubReturn';

type Connection = ReturnType<typeof useGithubConnection>;

/**
 * Connect GitHub through the Talyn GitHub App. A browser opens to authorize
 * and returns to the app. The connection is checked again when the browser
 * closes, when the return link arrives and when the app comes back.
 */
export function ConnectGitHubStep({ workspaceId, connection }: { workspaceId: string; connection: Connection }) {
  const c = useTheme();
  const offline = useNetwork() === 'offline';
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { status, user, installations, connected, refresh } = connection;
  const configured = status.data?.configured !== false;

  useEffect(() => onGithubReturn(() => {
    if (takeGithubReturn()?.result === 'error') setError('GitHub could not finish connecting. Please try again.');
  }), []);

  const connect = async () => {
    setConnecting(true);
    setError(null);
    try {
      await openGithubAppFlow(workspaceId, 'connect');
    } catch (failure) {
      setError(errorMessage(failure, 'Could not start the GitHub App install.'));
    } finally {
      setConnecting(false);
      void refresh();
    }
  };

  const detail = connected && user.data ? `Connected as @${user.data.login}`
    : status.status === 'loading' && !status.data ? 'Checking the connection…'
      : configured ? 'Not connected yet' : status.data?.message || 'GitHub is not set up on this server.';

  return <View style={styles.stack}>
    <AppText variant="body" tone="muted">
      Talyn tracks your pull requests, reviews, and CI status through GitHub. Connect your account to continue. A browser window opens to authorize, then you return here.
    </AppText>
    <View style={[styles.card, { backgroundColor: c.paper, borderColor: c.border }]}>
      <View style={[styles.icon, { backgroundColor: c.surface }]}>
        <SymbolView name={{ ios: 'chevron.left.forwardslash.chevron.right', android: 'code' }} size={20} tintColor={connected ? c.success : c.text} />
      </View>
      <View style={styles.main}>
        <View style={styles.titleLine}>
          <AppText variant="rowTitle">GitHub</AppText>
          {connected ? <Pill tone="success" icon={{ ios: 'checkmark', android: 'check' }} label="Connected" /> : null}
        </View>
        <AppText variant="meta" tone="muted">{detail}</AppText>
      </View>
    </View>
    {!connected ? <Button title={connecting ? 'Opening browser…' : 'Connect GitHub'} loading={connecting}
      disabled={connecting || !configured || offline} onPress={() => { void connect(); }} /> : null}
    {connected ? <GithubInstallStatus workspaceId={workspaceId} installations={installations.data ?? []}
      checked={installations.data !== undefined} loading={installations.status === 'loading' || installations.refreshing}
      onRefresh={() => { void refresh(); }} showAddAccount /> : null}
    {!connected ? <AppText variant="meta" tone="muted">
      You choose which org or account gets the Talyn app as part of that flow. The connection is detected when you return.
    </AppText> : null}
    {offline ? <Banner message="You are offline. Connect to the internet, then try again." /> : null}
    {error ? <Banner tone="destructive" message={error} /> : null}
  </View>;
}

const styles = StyleSheet.create({
  stack: { gap: 14 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth },
  icon: { width: 40, height: 40, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
  main: { flex: 1, gap: 2 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
