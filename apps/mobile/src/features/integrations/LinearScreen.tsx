import { linear } from '@talyn/client/native';
import { useState } from 'react';
import { Alert, View } from 'react-native';

import { useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { AppText, Banner, Button, Card, EmptyState, Pill } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { errorMessage } from '../../lib/errors';
import { appReturnBase, openReturnFlow } from '../../lib/returnTo';
import { Intro, Loading, Page } from '../more/Page';
import { useRemote } from '../more/useRemote';
import { isHttpsUrl, linearConnectionView, linearReturnError, withAppReturn } from './model';

/** Linear connection: connect an organization through the browser, see its state, disconnect. */
export function LinearScreen() {
  const workspaceId = useWorkspace().selected;
  const offline = useNetwork() === 'offline';
  const remote = useRemote(workspaceId ? `linear:${workspaceId}` : null, () => linear.getStatus(workspaceId as string));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (!workspaceId) return <Page><Loading /></Page>;

  const connect = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const { authorizeUrl } = await withAppReturn((returnTo) => linear.connect(returnTo ? { workspaceId, returnTo } : { workspaceId }
      ) , appReturnBase());
      if (!isHttpsUrl(authorizeUrl)) throw new Error('The Linear sign-in address is not valid.');
      await openReturnFlow(authorizeUrl, 'linear', (url) => setFailure(linearReturnError(url)));
      await remote.refresh();
    } catch (e) {
      Alert.alert('Could not start Linear sign-in', errorMessage(e, 'Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = (id: string, name: string) => Alert.alert(`Disconnect ${name}?`,
    'Talyn revokes its access. Linear rules stop until you connect again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: () => {
        void (async () => {
          try { await linear.disconnect(workspaceId, id); await remote.refresh(); }
          catch (e) { Alert.alert('Could not disconnect', errorMessage(e, 'Try again.')); }
        })();
      } },
    ]);

  const status = remote.data;
  const body = () => {
    if (!status) return <StateNotice resource={remote} offline={offline} refresh={() => { void remote.refresh(); }} />;
    if (!status.configured) return <EmptyState title="Linear is not set up" detail="This Talyn server has no Linear app yet." />;
    return <>
      {failure ? <Banner message={failure} /> : null}
      {status.connections.length === 0 ? <Card>
        <AppText variant="meta" tone="muted">No Linear organization is connected.</AppText>
      </Card> : null}
      {status.connections.map((connection) => {
        const view = linearConnectionView(connection);
        return <Card key={view.id}>
          <View style={{ gap: 8 }}>
            <AppText variant="body">{view.name}</AppText>
            <Pill label={view.needsReconnect ? 'Reconnect needed' : 'Connected'} tone={view.needsReconnect ? 'warning' : 'success'} />
            {view.needsReconnect ? <AppText variant="meta" tone="muted">{view.detail}</AppText> : null}
            {view.needsReconnect
              ? <Button title="Reconnect" onPress={() => { void connect(); }} disabled={busy || offline} loading={busy} />
              : null}
            <Button variant="quiet" size="sm" title="Disconnect" onPress={() => disconnect(view.id, view.name)} disabled={offline} />
          </View>
        </Card>;
      })}
      {status.connections.length === 0
        ? <Button title="Connect Linear" onPress={() => { void connect(); }} disabled={busy || offline} loading={busy} />
        : <View style={{ alignSelf: 'flex-start' }}>
          <Button variant="quiet" size="sm" title="Add another organization" onPress={() => { void connect(); }} disabled={busy || offline} />
        </View>}
    </>;
  };

  return <Page refreshing={remote.refreshing && status !== undefined} onRefresh={() => { void remote.refresh(); }}>
    <Intro>Connect a Linear organization so rules can start work from its issues.</Intro>
    {body()}
  </Page>;
}
