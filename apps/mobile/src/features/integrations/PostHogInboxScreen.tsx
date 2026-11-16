import { workflows } from '@talyn/client/native';
import { View } from 'react-native';

import { useNetwork, useWorkspace } from '../../auth/AuthProvider';
import { AppText, Card, Group, Pill } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { Fact, Intro, Loading, Page, WebRow } from '../more/Page';
import { useRemote } from '../more/useRemote';
import { postHogInboxCardView, postHogInboxPushText } from './model';

/** The PostHog Inbox connection, read-only. Connecting and disconnecting happen on the web. */
export function PostHogInboxScreen() {
  const workspaceId = useWorkspace().selected;
  const offline = useNetwork() === 'offline';
  const remote = useRemote(workspaceId ? `posthog-inbox:${workspaceId}` : null, () => workflows.posthogInboxStatus(workspaceId as string));
  if (!workspaceId) return <Page><Loading /></Page>;
  const status = remote.data;
  const view = status ? postHogInboxCardView(status) : null;
  // The PostHog push, read-only. The webhook URL is made and rotated on the web.
  const push = postHogInboxPushText(status);
  return <Page>
    <Intro>Talyn reads the PostHog Inbox through this connection. Manage it on the web.</Intro>
    {!status || !view ? <StateNotice resource={remote} offline={offline} refresh={() => { void remote.refresh(); }} /> : <>
      <Card>
        <View style={{ gap: 8 }}>
          <Pill label={view.badge} tone={view.tone} />
          {view.notes.map((note) => <AppText key={note} variant="meta" tone="muted">{note}</AppText>)}
          {view.connected && push ? <AppText variant="meta" tone="muted">{push}</AppText> : null}
        </View>
      </Card>
      {view.facts.length > 0 ? <Group>
        {view.facts.map((fact, i) => <Fact key={fact.label} label={fact.label} value={fact.value} divider={i < view.facts.length - 1} />)}
      </Group> : null}
    </>}
    <Group><WebRow title={view?.webLabel ?? 'Manage on the web'} path="/integrations/posthog_inbox" divider={false} /></Group>
  </Page>;
}
