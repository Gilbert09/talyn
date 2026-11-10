import { slack } from '@talyn/client/native';
import { workbenchesOffered, type SlackCustomEmoji, type SlackEmojiResponse, type SlackUserLinkView } from '@talyn/shared';
import * as Clipboard from 'expo-clipboard';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth, useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { PickerSheet, type PickerSection } from '../../components/PickerSheet';
import {
  AppText, Banner, Button, Card, EmptyState, IconButton, Pill, Row, useActionSheet, useToast, type SheetRequest,
} from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { trackEvent } from '../../lib/analytics';
import { errorMessage } from '../../lib/errors';
import { useFeatures } from '../../lib/features';
import { appReturnBase, openReturnFlow } from '../../lib/returnTo';
import { mono, radius, type, useTheme } from '../../theme/tokens';
import { isHttpsUrl, withAppReturn } from '../integrations/model';
import { Intro, Loading, Page } from '../more/Page';
import { useRemote } from '../more/useRemote';
import {
  customEmojiChoices, inviteCommand, linkWorkspaceId, loadSlack, mergeTeams, notConfiguredMessage, SLACK_INTRO, TEAM_ACTION_LABEL,
  teamView, typedEmoji, withEmoji, withoutEmoji, type SlackLoad, type TeamAction, type TeamEntry,
} from './model';

type StartKind = 'install' | 'link';

/**
 * Settings → Slack, like web `SlackSettings`: install the Talyn app in a Slack
 * workspace, link your Slack account, choose the trigger emoji and the Talyn
 * workspace sessions go to. Slack's pages open in the browser and return here.
 */
/** Web's `slack_connected`: the callback says `slack=installed` for a workspace and `slack=linked` for an account. */
function trackSlackReturn(url: string) {
  let outcome: string | null = null;
  try { outcome = new URL(url).searchParams.get('slack'); } catch { return; }
  if (outcome === 'installed') trackEvent('slack_connected', { connection_kind: 'workspace' });
  else if (outcome === 'linked') trackEvent('slack_connected', { connection_kind: 'account' });
}

export function SlackScreen() {
  const features = useFeatures();
  const offered = workbenchesOffered(features);
  const user = useAuth().user?.id ?? null;
  const workspaceId = useWorkspace().selected;
  const offline = useNetwork() === 'offline';
  const remote = useRemote<SlackLoad>(offered && user ? `slack:${user}` : null, () => loadSlack(() => slack.getStatus()));
  const [notConfigured, setNotConfigured] = useState<string | null>(null);
  const [busy, setBusy] = useState<StartKind | null>(null);
  const menu = useActionSheet();
  const toast = useToast();

  if (features === null) return <Page><Loading /></Page>;
  if (!offered) return <Page><EmptyState title="Slack is not available" detail="Slack sessions are not on for this account." /></Page>;

  const start = async (kind: StartKind) => {
    setBusy(kind);
    try {
      const input = workspaceId ? { workspaceId } : {};
      const { authorizeUrl } = await withAppReturn((returnTo) => {
        const body = returnTo ? { ...input, returnTo } : input;
        return kind === 'install' ? slack.install(body) : slack.link(body);
      }, appReturnBase());
      if (!isHttpsUrl(authorizeUrl)) throw new Error('The Slack sign-in address is not valid.');
      await openReturnFlow(authorizeUrl, 'slack', trackSlackReturn);
      await remote.refresh();
    } catch (e) {
      const message = notConfiguredMessage(e);
      if (message) setNotConfigured(message);
      else Alert.alert('Could not start Slack sign-in', errorMessage(e, 'Try again.'));
    } finally {
      setBusy(null);
    }
  };

  const data = remote.data;
  const blocked = notConfigured ?? (data?.kind === 'not_configured' ? data.message : null);
  const body = () => {
    if (blocked) return <Card><AppText variant="meta" tone="muted">{blocked}</AppText></Card>;
    if (data?.kind === 'unavailable') return <EmptyState title="Slack is not available" detail="Slack sessions are not on for this account." />;
    if (data?.kind !== 'ready') return <StateNotice resource={remote} offline={offline} refresh={() => { void remote.refresh(); }} />;
    const { installations } = data.status;
    const disabled = busy !== null || offline;
    return <>
      {installations.length === 0 ? <Card>
        <AppText variant="meta" tone="muted">Talyn is not installed in any Slack workspace yet.</AppText>
        <Button title="Connect Slack" onPress={() => { void start('install'); }} disabled={disabled} loading={busy === 'install'} />
      </Card> : null}
      {mergeTeams(data.status).map((team) => <TeamCard key={team.teamId} team={team} busy={busy} offline={offline}
        onStart={start} onChanged={() => remote.refresh()} openSheet={menu.open} toast={toast.show} />)}
      {installations.length > 0 ? <View style={{ alignSelf: 'flex-start' }}>
        <Button variant="quiet" size="sm" title="Add another Slack workspace" onPress={() => { void start('install'); }} disabled={disabled} />
      </View> : null}
    </>;
  };

  return <View style={{ flex: 1 }}>
    <Page refreshing={remote.refreshing && data !== undefined} onRefresh={() => { setNotConfigured(null); void remote.refresh(); }}>
      <Intro>{SLACK_INTRO}</Intro>
      {body()}
    </Page>
    {menu.sheet}
    {toast.element}
  </View>;
}

function TeamCard({ team, busy, offline, onStart, onChanged, openSheet, toast }: {
  team: TeamEntry; busy: StartKind | null; offline: boolean; onStart(kind: StartKind): Promise<void>; onChanged(): Promise<void>;
  openSheet(request: SheetRequest): void; toast(message: string): void;
}) {
  const { installation, link } = team;
  const view = teamView(team);
  const [working, setWorking] = useState(false);
  const disabled = busy !== null || offline;

  const run = async (action: () => Promise<void>, failure: string) => {
    setWorking(true);
    try { await action(); await onChanged(); }
    catch (e) { Alert.alert(failure, errorMessage(e, 'Try again.')); }
    finally { setWorking(false); }
  };

  const unlink = () => link && Alert.alert(`Unlink your Slack account from ${view.name}?`, undefined, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Unlink', style: 'destructive', onPress: () => { void run(async () => { await slack.unlink(link.id); trackEvent('slack_disconnected', { connection_kind: 'account' }); toast('Slack account unlinked'); }, 'Could not unlink'); } },
  ]);

  const disconnect = () => Alert.alert(`Disconnect ${view.name}?`,
    'This makes Talyn forget its access token. The app stays installed in Slack until you remove it there.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: () => { void run(async () => {
        const res = await slack.forgetInstallation(team.teamId);
        trackEvent('slack_disconnected', { connection_kind: 'workspace' });
        Alert.alert('Slack workspace disconnected', res.message);
      }, 'Could not disconnect'); } },
    ]);

  const perform: Record<TeamAction, () => void> = {
    reconnect: () => { void onStart('install'); },
    unlink: () => { unlink(); },
    disconnect,
  };
  const openMenu = () => openSheet({ title: view.name, actions: view.actions.map((action) => ({
    label: TEAM_ACTION_LABEL[action], destructive: action !== 'reconnect', onPress: perform[action],
    disabled: action === 'reconnect' ? disabled : offline || working,
  })) });

  return <Card>
    <View style={styles.header}>
      <AppText accessibilityRole="header" variant="rowTitle" numberOfLines={1} style={{ flexShrink: 1 }}>{view.name}</AppText>
      <Pill label={view.pill.label} tone={view.pill.tone} />
      <View style={{ flex: 1 }} />
      <IconButton label={`Actions for ${view.name}`} symbol={{ ios: 'ellipsis', android: 'more_horiz' }} onPress={openMenu} />
    </View>
    {view.brokenMessage ? <Banner message={view.brokenMessage} tone="warning" action="Reconnect" actionDisabled={disabled}
      onAction={() => { void onStart('install'); }} /> : null}
    {view.canLink ? <Button title="Link my Slack account" onPress={() => { void onStart('link'); }} disabled={disabled} loading={busy === 'link'} /> : null}
    {link ? <>
      <TargetWorkspaceRow link={link} offline={offline} openSheet={openSheet} />
      <TriggerEmoji key={`${link.id}:${link.triggerEmojis.join(',')}`} link={link} teamId={team.teamId} offline={offline}
        onReconnect={() => { void onStart('install'); }} />
      {installation ? <InviteHint botName={installation.botName} toast={toast} /> : null}
    </> : null}
  </Card>;
}

type SaveState = 'idle' | 'saving' | 'saved';

function TargetWorkspaceRow({ link, offline, openSheet }: { link: SlackUserLinkView; offline: boolean; openSheet(request: SheetRequest): void }) {
  const workspaces = useWorkspace().choices;
  const [value, setValue] = useState(() => linkWorkspaceId(link, workspaces));
  const [state, setState] = useState<SaveState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // One Talyn workspace: nothing to choose.
  if (workspaces.length <= 1) return null;

  const save = async (next: string, previous: string) => {
    setValue(next);
    setState('saving');
    try {
      await slack.updateLink(link.id, { workspaceId: next });
      setState('saved');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), 2000);
    } catch (e) {
      setValue(previous);
      setState('idle');
      Alert.alert('Could not save.', errorMessage(e, 'Try again.'), [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Retry', onPress: () => { void save(next, previous); } },
      ]);
    }
  };

  const name = workspaces.find((workspace) => workspace.id === value)?.name ?? 'Choose';
  const trailing = state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : name;
  return <Row title="Workspace" chevron divider={false} disabled={state === 'saving' || offline}
    subtitle="Sessions from this Slack workspace start here."
    accessibilityLabel={`Target workspace. ${name}.`}
    trailing={<AppText variant="meta" tone={state === 'saved' ? 'success' : 'muted'} numberOfLines={1} style={{ maxWidth: '50%' }}>{trailing}</AppText>}
    onPress={() => openSheet({ title: 'Target workspace',
      message: 'Sessions started from this Slack workspace are created in this Talyn workspace, and the repository is picked from its repositories.',
      actions: workspaces.map((workspace) => ({ label: workspace.name, selected: workspace.id === value,
        onPress: () => { if (workspace.id !== value) void save(workspace.id, value); } })) })} />;
}

function TriggerEmoji({ link, teamId, offline, onReconnect }: { link: SlackUserLinkView; teamId: string; offline: boolean; onReconnect(): void }) {
  const [emojis, setEmojis] = useState<string[]>(link.triggerEmojis);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const saveSeq = useRef(0);
  // The custom emoji only draw the chips and the picker, so a failed read shows none.
  const custom = useRemote<SlackEmojiResponse>(`slack-emoji:${teamId}`,
    () => slack.listEmoji(teamId).catch((): SlackEmojiResponse => ({ emoji: [] })));
  const customList = custom.data?.emoji ?? [];
  const needsScope = custom.data?.needsScope === 'emoji:read';

  const persist = async (next: string[]) => {
    const previous = emojis;
    const seq = ++saveSeq.current;
    setEmojis(next);
    try {
      await slack.updateLink(link.id, { triggerEmojis: next });
    } catch (e) {
      if (seq === saveSeq.current) setEmojis(previous);
      Alert.alert('Could not save trigger emojis', errorMessage(e, 'Try again.'));
    }
  };

  const pick = (name: string) => {
    setPicking(false);
    setQuery('');
    void persist(withEmoji(emojis, name));
  };

  const matches = customEmojiChoices(customList, query, emojis);
  const typed = typedEmoji(query, emojis);
  const sections: PickerSection[] = [];
  if (typed && !matches.some((emoji) => emoji.name === typed)) {
    sections.push({ key: 'typed', items: [{ key: `typed:${typed}`, label: `:${typed}:`, mono: true, detail: 'Use this shortcode',
      accessibilityLabel: `Add :${typed}:`, onPress: () => pick(typed) }] });
  } else if (!query.trim()) {
    sections.push({ key: 'hint', note: 'Type an emoji shortcode, such as robot_face.', items: [] });
  }
  if (matches.length) {
    sections.push({ key: 'custom', title: 'This workspace', items: matches.map((emoji) => ({ key: emoji.name, label: `:${emoji.name}:`,
      leading: <CustomEmojiImage emoji={emoji} size={20} />, accessibilityLabel: `Add :${emoji.name}:`, onPress: () => pick(emoji.name) })) });
  }

  return <View style={{ gap: 8 }}>
    <AppText variant="meta" tone="muted">Trigger emoji</AppText>
    <View style={styles.chips}>
      {emojis.map((name) => <EmojiChip key={name} name={name} custom={customList.find((emoji) => emoji.name === name)}
        disabled={offline} onRemove={() => { void persist(withoutEmoji(emojis, name)); }} />)}
      <Button variant="secondary" size="sm" icon={{ ios: 'plus', android: 'add' }} title="Add emoji" disabled={offline}
        onPress={() => { setQuery(''); setPicking(true); }} />
    </View>
    {emojis.length === 0 ? <AppText variant="meta" tone="muted">No emoji. Reactions will not start a session.</AppText> : null}
    {needsScope ? <AppText variant="meta" tone="muted">
      {'Reconnect Slack to show your workspace\'s custom emoji. '}
      <AppText variant="meta" tone="primary" accessibilityRole="button" onPress={onReconnect}>Reconnect</AppText>
    </AppText> : null}
    <PickerSheet visible={picking} title="Add emoji" onClose={() => setPicking(false)} sections={sections}
      search={{ value: query, onChange: setQuery, placeholder: 'Search emoji', accessibilityLabel: 'Search emoji' }}
      empty={<AppText variant="meta" tone="muted" style={{ textAlign: 'center', paddingVertical: 16 }}>No emoji found.</AppText>} />
  </View>;
}

function CustomEmojiImage({ emoji, size }: { emoji: SlackCustomEmoji; size: number }) {
  if (!isHttpsUrl(emoji.url)) return null;
  return <Image source={{ uri: emoji.url }} accessibilityIgnoresInvertColors style={{ width: size, height: size }} resizeMode="contain" />;
}

function EmojiChip({ name, custom, disabled, onRemove }: { name: string; custom?: SlackCustomEmoji; disabled: boolean; onRemove(): void }) {
  const c = useTheme();
  return <View style={[styles.chip, { backgroundColor: c.surface, borderColor: c.border }]}>
    {custom ? <CustomEmojiImage emoji={custom} size={16} /> : null}
    <Text style={[type.meta, mono(500), { color: c.text }]}>:{name}:</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`Remove :${name}:`} disabled={disabled} hitSlop={8} onPress={onRemove}
      style={{ opacity: disabled ? 0.45 : 1 }}>
      <SymbolView name={{ ios: 'xmark', android: 'close' }} size={12} tintColor={c.muted} />
    </Pressable>
  </View>;
}

function InviteHint({ botName, toast }: { botName: string | null; toast(message: string): void }) {
  const command = inviteCommand(botName);
  const copy = async () => {
    try {
      await Clipboard.setStringAsync(command);
      toast('Copied');
    } catch {
      Alert.alert('Could not copy', 'Select the command and copy it by hand.');
    }
  };
  return <View style={styles.invite}>
    <AppText variant="meta" tone="muted">Add Talyn to a channel:</AppText>
    <AppText variant="meta" selectable style={mono(500)}>{command}</AppText>
    <IconButton label="Copy invite command" symbol={{ ios: 'doc.on.doc', android: 'content_copy' }} size={16} onPress={() => { void copy(); }} />
  </View>;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6, paddingLeft: 10, paddingRight: 8,
    borderRadius: radius.round, borderWidth: StyleSheet.hairlineWidth },
  invite: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
});
