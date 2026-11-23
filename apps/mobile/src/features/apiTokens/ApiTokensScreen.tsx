import { apiTokens } from '@talyn/client/native';
import type { ApiToken } from '@talyn/shared';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { AppText, Banner, Button, EmptyState, Group, Pill, Row } from '../../components/UI';
import { openExternal } from '../../components/Workflow';
import { errorMessage } from '../../lib/errors';
import { useFeatures } from '../../lib/features';
import { Intro, Loading, Page } from '../more/Page';
import { useRemote } from '../more/useRemote';
import { spacesOffered } from '../spaces/model';
import { expiry, OPENAPI_URL, scopeChips, tokensView, usageLine, workspaceLabel } from './model';

export const CREATE_TOKEN_ROUTE = '/settings/apiTokens/new' as Href;

/**
 * Personal tokens for the public API, like web Settings → API tokens. The
 * full token shows once, on the create screen. Here only its prefix shows.
 * Only minting needs the `publicApi` flag: listing and revoking always work.
 */
export function ApiTokensScreen() {
  const features = useFeatures();
  const router = useRouter();
  const offline = useNetwork() === 'offline';
  const workspaces = useWorkspace().choices;
  const tokens = useRemote<ApiToken[]>('api-tokens', () => apiTokens.list());
  const [revoking, setRevoking] = useState<string | null>(null);
  const publicApi = features?.publicApi === true;
  const offered = spacesOffered(features);

  // Coming back from the create screen shows the new token.
  const opened = useRef(false);
  useFocusEffect(useCallback(() => {
    if (opened.current) void tokens.refresh();
    opened.current = true;
  }, [tokens.refresh]));

  const view = tokensView({ features: features === null ? 'loading' : publicApi, tokens: tokens.data,
    failed: tokens.status === 'error' || tokens.status === 'offline' || tokens.status === 'unauthorized' });

  const revoke = (token: ApiToken) => Alert.alert(`Revoke "${token.name}"?`, 'Anything that uses this token stops working at once. You cannot undo this.', [
    { text: 'Cancel', style: 'cancel', isPreferred: true },
    { text: 'Revoke token', style: 'destructive', onPress: () => {
      setRevoking(token.id);
      void apiTokens.revoke(token.id).then(() => {
        tokens.mutate((list) => list.filter((item) => item.id !== token.id));
      }, (error: unknown) => {
        Alert.alert('Could not revoke the token', errorMessage(error, 'Please try again.'));
      }).finally(() => setRevoking(null));
    } },
  ]);

  const create = publicApi ? <Button title="Create token" icon={{ ios: 'plus', android: 'add' }} size="sm" disabled={offline}
    onPress={() => router.push(CREATE_TOKEN_ROUTE)} /> : null;
  const now = Date.now();

  return <Page refreshing={tokens.refreshing} onRefresh={() => { void tokens.refresh(); }}>
    <Intro>Call the Talyn API from your own scripts and tools. A token acts as you, with only the access you give it.</Intro>
    {offline ? <Banner message="You are offline. Connect to the internet to create or revoke tokens." /> : null}
    {view === 'loading' ? <Loading label="Loading tokens" /> : null}
    {view === 'unavailable' ? <EmptyState title="API tokens are not available" detail="You cannot create API tokens on this account yet." /> : null}
    {view === 'error' ? <Banner tone="destructive" message="Could not load your tokens." action="Try again" actionDisabled={offline}
      onAction={() => { void tokens.refresh(); }} /> : null}
    {view === 'list' && tokens.data ? <>
      {tokens.data.length === 0 ? <EmptyState title="No API tokens yet" detail="Create a token to use Talyn from a script, a CI job or another tool.">
        {create}
      </EmptyState> : <Group title="Tokens" footer={publicApi ? undefined : 'You cannot create new tokens right now. You can still revoke the tokens you have.'}>
        {tokens.data.map((token, index) => {
          const exp = expiry(token, now);
          const expired = exp.tone === 'expired';
          return <Row key={token.id} title={token.name} titleLines={1} divider={index < tokens.data!.length - 1}
            accessibilityLabel={`${token.name}. ${token.tokenPrefix}. ${exp.text}.`}
            trailing={<Button title="Revoke" variant="quiet" size="sm" accessibilityLabel={`Revoke ${token.name}`}
              disabled={offline || revoking === token.id} loading={revoking === token.id} onPress={() => revoke(token)} />}>
            <View style={styles.meta}>
              <AppText variant="mono" tone="muted" selectable>{token.tokenPrefix}…</AppText>
              {expired ? <Pill label="Expired" tone="destructive" /> : null}
            </View>
            <View style={styles.chips}>
              {scopeChips(token.scopes, offered).map((chip) => <Pill key={chip} label={chip} />)}
            </View>
            <AppText variant="meta" tone="muted" numberOfLines={2}>{workspaceLabel(token.workspaceIds, workspaces)}</AppText>
            <AppText variant="caption" tone="muted">{usageLine(token, now)}</AppText>
            <AppText variant="caption" tone={expired ? 'destructive' : exp.tone === 'soon' ? 'warning' : 'muted'}>{exp.text}</AppText>
          </Row>;
        })}
      </Group>}
      {tokens.data.length > 0 && create ? <View style={{ alignSelf: 'flex-start' }}>{create}</View> : null}
    </> : null}
    <Group>
      <Row title="API reference" chevron divider={false} accessibilityRole="link" onPress={() => openExternal(OPENAPI_URL)} />
    </Group>
  </Page>;
}

const styles = StyleSheet.create({
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
});
