import { useLocalSearchParams } from 'expo-router';

import { ShellScreen, ShellText } from '../../../src/components/ShellScreen';
import { exampleWorkbenchKinds } from '../../../src/domain/examples';

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<'/threads/[id]'>();
  return (
    <ShellScreen title="Example thread" description="The conversation and its sessions will appear here.">
      <ShellText>Thread: {id}</ShellText>
      <ShellText>Work types: {exampleWorkbenchKinds.join(', ')}</ShellText>
    </ShellScreen>
  );
}
