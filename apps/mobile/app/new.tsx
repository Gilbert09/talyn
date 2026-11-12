import { useLocalSearchParams } from 'expo-router';

import { NewWorkScreen } from '../src/features/create/NewWorkScreen';
import { DetailRoute } from '../src/navigation/DetailRoute';

export default function Screen() {
  const { mode, repository, pullRequest } = useLocalSearchParams<{ mode?: string; repository?: string; pullRequest?: string }>();
  const initial = mode === 'thread' ? 'thread' : 'session';
  return <DetailRoute list={initial === 'thread' ? '/threads' : '/sessions'}>
    <NewWorkScreen initialMode={initial} initialRepositoryId={repository} initialPullRequestId={pullRequest} />
  </DetailRoute>;
}
