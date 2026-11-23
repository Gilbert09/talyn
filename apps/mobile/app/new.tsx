import { useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';

import { NewWorkScreen } from '../src/features/create/NewWorkScreen';
import { DetailRoute } from '../src/navigation/DetailRoute';
import { completeShare } from '../src/navigation/intents';

/** Inside the workspace gate: a shared item is done once the composer shows it, not when the gate sends it on. */
function ShareShown() {
  useEffect(() => { completeShare(); }, []);
  return null;
}

export default function Screen() {
  const { mode, repository, pullRequest, prompt } = useLocalSearchParams<{ mode?: string; repository?: string; pullRequest?: string; prompt?: string }>();
  const initial = mode === 'thread' ? 'thread' : 'session';
  return <DetailRoute list={initial === 'thread' ? '/threads' : '/sessions'}>
    {prompt ? <ShareShown /> : null}
    <NewWorkScreen initialMode={initial} initialRepositoryId={repository} initialPullRequestId={pullRequest} initialPrompt={prompt} />
  </DetailRoute>;
}
