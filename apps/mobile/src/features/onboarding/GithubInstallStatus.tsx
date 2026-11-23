import type { GitHubInstallation } from '@talyn/client/native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText, Banner, Button, Pill, Spinner } from '../../components/UI';
import { trackEvent } from '../../lib/analytics';
import { showActionError } from '../../lib/errors';
import { formatOwnerList, openGithubAppFlow, uncoveredOwners } from './githubFlow';

/** The coverage warning, like web's. Nothing is said before the first check, so no false warning flashes. */
export function coverageWarning(installations: readonly GitHubInstallation[], checked: boolean, watchedOwners: readonly string[]): string | null {
  if (!checked) return null;
  const uncovered = uncoveredOwners(watchedOwners, installations);
  if (installations.length === 0) {
    return 'The Talyn GitHub App is not installed on any account yet. Install it on the org or account whose repositories you want to track. Without it, Talyn can only poll public repositories, and gets no live updates.';
  }
  if (uncovered.length) {
    return `The Talyn GitHub App is not installed on ${formatOwnerList(uncovered)}, or your GitHub account cannot reach it. Talyn polls public repositories there every few minutes instead of getting live updates. Install it there for live updates.`;
  }
  return null;
}

/**
 * Where the Talyn GitHub App is installed, and a way to install it where it is
 * missing. Shared by onboarding and the repositories screen.
 */
export function GithubInstallStatus({ workspaceId, installations, checked, loading, watchedOwners = [], onRefresh, showAddAccount = false }: {
  workspaceId: string; installations: readonly GitHubInstallation[]; checked: boolean; loading: boolean;
  watchedOwners?: readonly string[]; onRefresh(): void; showAddAccount?: boolean;
}) {
  const [opening, setOpening] = useState(false);
  const warning = coverageWarning(installations, checked, watchedOwners);
  // The very first install runs authorization again. Another account uses GitHub's install page.
  const mode = installations.length === 0 ? 'connect' : 'manage';

  const install = async (target: 'connect' | 'manage') => {
    setOpening(true);
    // A first install outside onboarding is web's `panel` source.
    if (target === 'connect') trackEvent('github_connect_started', { source: 'panel' });
    try { await openGithubAppFlow(workspaceId, target); } catch (error) { showActionError('Could not open GitHub', error); } finally { setOpening(false); }
    onRefresh();
  };

  if (!checked && loading && installations.length === 0) {
    return <View style={styles.inline}><Spinner /><AppText variant="meta" tone="muted">Checking which accounts have the Talyn app…</AppText></View>;
  }

  return <View style={styles.stack}>
    {installations.length ? <View style={styles.wrap} accessibilityLabel="App installed on">
      <AppText variant="meta" tone="muted">App installed on</AppText>
      {installations.map((item) => <Pill key={item.accountLogin} tone={item.suspended ? 'warning' : 'success'}
        icon={item.suspended ? { ios: 'exclamationmark.triangle', android: 'warning' } : { ios: 'checkmark', android: 'check' }}
        label={`@${item.accountLogin}${item.suspended ? ' · suspended' : ''}`}
        accessibilityLabel={item.suspended ? `@${item.accountLogin}, installation suspended on GitHub`
          : `@${item.accountLogin}, ${item.repositorySelection === 'selected' ? 'selected repositories' : 'all repositories'}`} />)}
    </View> : null}
    {warning ? <>
      <Banner message={warning} />
      <View style={styles.wrap}>
        <Button size="sm" title="Install on GitHub" icon={{ ios: 'plus', android: 'add' }} loading={opening} disabled={opening}
          onPress={() => { void install(mode); }} />
        <Button size="sm" variant="quiet" title="Check again" disabled={loading} onPress={onRefresh} />
      </View>
    </> : null}
    {!warning && showAddAccount && installations.some((item) => !item.suspended) ? <View style={styles.start}>
      <Button size="sm" variant="quiet" title="Install on another account" icon={{ ios: 'plus', android: 'add' }} loading={opening}
        disabled={opening} onPress={() => { void install('manage'); }} />
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  stack: { gap: 10 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  start: { alignSelf: 'flex-start' },
});
