import { useAuth, useMobileRuntime, useNetwork, useWorkspace } from '../../../src/auth/AuthProvider';
import { Status } from '../../../src/components/AuthControls';
import { Button, Group, Row } from '../../../src/components/UI';
import { Page } from '../../../src/features/more/Page';
import { SpaceNotificationSettings } from '../../../src/features/spaces/SpaceNotificationSettings';
import { ColdBack } from '../../../src/navigation/DetailRoute';

export default function NotificationsScreen() {
  const { status, choices, selected } = useWorkspace();
  const { workspace } = useMobileRuntime();
  const user = useAuth().user;
  const offline = useNetwork() === 'offline';

  return <><ColdBack list="/settings" /><Page>
    <Group title="Workspaces" footer="Phone alerts, quiet hours and delivery settings.">
      {choices.map((choice, index) => <Row key={choice.id} title={choice.name} chevron
        subtitle={choice.id === selected ? 'Current workspace' : undefined}
        accessibilityLabel={choice.id === selected ? `${choice.name}, current workspace` : choice.name}
        divider={index < choices.length - 1}
        href={{ pathname: '/settings/notifications/workspace/[id]', params: { id: choice.id } }} />)}
      {(status === 'idle' || status === 'loading') && !choices.length ? <Status message="Loading workspaces" loading /> : null}
      {status === 'ready' && !choices.length ? <Status message="You have no workspaces." /> : null}
      {status === 'error' ? <>
        <Status message="Workspaces could not load." tone="warning" />
        <Button title="Retry" disabled={offline} onPress={() => { if (user) void workspace.load(user.id); }} />
      </> : null}
    </Group>
    <SpaceNotificationSettings offline={offline} />
  </Page></>;
}
