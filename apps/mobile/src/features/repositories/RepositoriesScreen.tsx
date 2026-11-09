import type { GitHubRepo, WatchedRepo } from '@talyn/client/native';
import { sizePriceTable, type SandboxSizeSetting } from '@talyn/shared';
import { router, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { PickerSheet } from '../../components/PickerSheet';
import { AppText, Banner, Group, IconButton, Input, Pill, Row, Spinner } from '../../components/UI';
import { showActionError } from '../../lib/errors';
import { radius, useTheme } from '../../theme/tokens';
import { Page } from '../more/Page';
import { useGithubConnection, isOwnerCovered } from '../onboarding/githubFlow';
import { GithubInstallStatus } from '../onboarding/GithubInstallStatus';
import { useBillingStatus } from '../usage/data';
import { usageViewOf } from '../usage/model';
import { useAllRepos, useSandboxSize, useWatchedRepos } from './data';
import { effectiveLocked, formatAge, matchRepos, sizeHint, sizeName, sizeOptions, sizeSummary } from './model';

const BILLING = '/billing' as Href;

/** The plan tier and its size prices, or null when billing is off on this server. */
function usePlanSizes() {
  const view = usageViewOf(useBillingStatus().data);
  return view ? { tier: view.tier, prices: view.status.sizePrices ?? sizePriceTable(view.tier) } : null;
}

/**
 * Choose the repositories sessions can use, like web's "Watch repositories"
 * step: search every repository the GitHub account can see, add or remove
 * one, and pick each one's sandbox size. Shared by onboarding and the
 * Repositories screen, so it draws no scroll view of its own.
 */
export function RepositoriesPanel({ workspaceId }: { workspaceId: string }) {
  const c = useTheme();
  const offline = useNetwork() === 'offline';
  const all = useAllRepos(workspaceId);
  const watched = useWatchedRepos(workspaceId);
  const { installations, refresh: refreshGithub } = useGithubConnection(workspaceId);
  const [search, setSearch] = useState('');
  const covered = installations.data;
  const checked = covered !== undefined;
  const matches = matchRepos(all.repos, watched.list, search);

  const add = (repo: GitHubRepo) => {
    watched.add(repo).catch((error: unknown) => showActionError('Could not add the repository', error));
  };
  const remove = (repo: WatchedRepo) => {
    watched.remove(repo.id).catch((error: unknown) => showActionError('Could not remove the repository', error));
  };

  return <View style={styles.stack}>
    <AppText variant="meta" tone="muted">Choose at least one repository for your sessions.</AppText>

    {watched.list.length ? <Group title="Your repositories">
      {watched.list.map((repo, index) => <WatchedRow key={repo.id} repo={repo} divider={index < watched.list.length - 1}
        uncovered={checked && !isOwnerCovered(repo.owner, covered ?? [])} busy={watched.busy === repo.id || offline}
        onRemove={() => remove(repo)} />)}
    </Group> : null}

    <GithubInstallStatus workspaceId={workspaceId} installations={covered ?? []} checked={checked}
      loading={installations.status === 'loading' || installations.refreshing}
      watchedOwners={watched.list.map((repo) => repo.owner)} onRefresh={() => { void refreshGithub(); }} />

    <View style={styles.searchRow}>
      <View style={styles.searchField}>
        <Input value={search} onChangeText={setSearch} placeholder="Search all your repositories…" accessibilityLabel="Search repositories"
          autoCapitalize="none" autoCorrect={false} returnKeyType="search" />
      </View>
      <IconButton label="Refresh the repository list" symbol={{ ios: 'arrow.clockwise', android: 'refresh' }}
        disabled={all.loading || offline} onPress={() => { void all.refresh(); }} />
    </View>
    <AppText variant="meta" tone="muted">
      Your repositories and every org you belong to. {all.loading ? 'Refreshing…' : all.fetchedAt ? `Updated ${formatAge(all.fetchedAt)}.` : ''}
    </AppText>

    {all.firstLoad ? <View style={[styles.notice, { borderColor: c.border }]} accessibilityState={{ busy: true }}>
      <Spinner />
      <View style={{ flex: 1, gap: 2 }}>
        <AppText variant="meta">Loading your repositories from GitHub…</AppText>
        <AppText variant="meta" tone="muted">This includes every organisation you belong to, so it can take a moment.</AppText>
      </View>
    </View> : all.failed && !all.repos.length ? <Banner message="Could not load your repositories from GitHub. Try refresh." />
      : matches.shown.length ? <View style={[styles.results, { borderColor: c.border }]}>
        {matches.shown.map((repo, index) => <Row key={repo.id} title={repo.full_name} titleLines={1}
          accessibilityLabel={`Add ${repo.full_name}`} divider={index < matches.shown.length - 1}
          disabled={watched.busy !== null || offline} onPress={() => add(repo)}
          leading={watched.busy === repo.full_name ? <Spinner /> : <SymbolView name={{ ios: 'plus.circle', android: 'add_circle' }} size={18} tintColor={c.primaryAction} />}
          trailing={<View style={styles.pills}>
            {checked && !isOwnerCovered(repo.owner.login, covered ?? []) ? <Pill tone="warning" label="App not installed" /> : null}
            {repo.private ? <Pill label="Private" /> : null}
          </View>} />)}
      </View> : <AppText variant="meta" tone="muted" style={styles.padded}>
        {search ? 'No matching repositories. Try refresh if a repository is missing.' : 'No repositories found. Try refresh.'}
      </AppText>}
    {matches.truncated ? <AppText variant="meta" tone="muted">Showing the first {matches.shown.length} of {matches.total}. Type to narrow.</AppText> : null}
  </View>;
}

function WatchedRow({ repo, divider, uncovered, busy, onRemove }: {
  repo: WatchedRepo; divider: boolean; uncovered: boolean; busy: boolean; onRemove(): void;
}) {
  const size = useSandboxSize(repo.id);
  const plan = usePlanSizes();
  const [open, setOpen] = useState(false);
  const locked = size.data ? effectiveLocked(size.data, plan?.tier ?? null) : false;
  return <>
    <Row title={repo.fullName} titleLines={1} divider={divider} onPress={() => setOpen(true)}
    accessibilityLabel={`${repo.fullName}, sandbox size ${size.data ? sizeSummary(size.data) : 'loading'}`}
    subtitle={size.data ? `Sandbox: ${sizeSummary(size.data)}` : 'Sandbox size: checking…'}
    trailing={<View style={styles.pills}>
      {uncovered ? <Pill tone="warning" label="App not installed" /> : null}
      {locked ? <Pill tone="warning" label="Needs Pro" /> : null}
      <IconButton label={`Remove ${repo.fullName}`} symbol={{ ios: 'trash', android: 'delete' }} tone="destructive" size={16}
        disabled={busy} onPress={onRemove} />
    </View>} />
    {open ? <SandboxSizeSheet repo={repo} size={size} onClose={() => setOpen(false)} /> : null}
  </>;
}

/** The size picker for a repository that has no row on screen, such as from a refusal. */
export function RepoSandboxSizeSheet({ repo, onClose }: { repo: Pick<WatchedRepo, 'id' | 'fullName'>; onClose(): void }) {
  return <SandboxSizeSheet repo={repo} size={useSandboxSize(repo.id)} onClose={onClose} />;
}

/** The sandbox size of one repository. A size the plan cannot start opens Plan and credits. */
function SandboxSizeSheet({ repo, size, onClose }: {
  repo: Pick<WatchedRepo, 'id' | 'fullName'>; size: ReturnType<typeof useSandboxSize>; onClose(): void;
}) {
  const plan = usePlanSizes();
  const [saving, setSaving] = useState(false);
  const info = size.data;
  const choose = (setting: SandboxSizeSetting) => {
    setSaving(true);
    size.save(setting).catch((error: unknown) => showActionError('Could not save the sandbox size', error)).finally(() => setSaving(false));
  };
  const options = info ? sizeOptions(info, plan?.tier ?? null, plan?.prices ?? null) : [];
  const hint = info ? sizeHint(info) : null;
  const locked = info ? effectiveLocked(info, plan?.tier ?? null) : false;
  return <PickerSheet visible title="Sandbox size" onClose={onClose}
    header={<View style={styles.sheetHeader}>
      <AppText variant="meta" tone="muted" numberOfLines={1}>{repo.fullName}</AppText>
      {!info ? <Spinner /> : null}
      {hint ? <AppText variant="meta" tone="muted">{hint}</AppText> : null}
      {info && locked ? <AppText variant="meta" tone="warning">
        {`${sizeName(info.effective)} boxes need Pro. On your plan a new session here cannot start until you pick Standard or Small.`}
      </AppText> : null}
    </View>}
    sections={[{ key: 'sizes', items: options.map((option) => ({
      key: option.setting, label: option.label, detail: option.detail, selected: option.selected, disabled: saving,
      accessibilityLabel: option.locked ? `${option.label}, requires Pro. Opens plan and credits.` : option.label,
      onPress: () => {
        if (option.locked) { router.push(BILLING); return; }
        if (!option.selected) choose(option.setting);
      },
    })) }]} />;
}

/** The Repositories screen, opened from settings and from home. */
export function RepositoriesScreen() {
  const workspace = useWorkspace().selected;
  if (!workspace) return null;
  return <Page>
    <RepositoriesPanel key={workspace} workspaceId={workspace} />
  </Page>;
}

const styles = StyleSheet.create({
  stack: { gap: 14 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchField: { flex: 1 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 12, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  results: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  pills: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  padded: { paddingVertical: 4 },
  sheetHeader: { paddingHorizontal: 16, paddingBottom: 8, gap: 4 },
});
