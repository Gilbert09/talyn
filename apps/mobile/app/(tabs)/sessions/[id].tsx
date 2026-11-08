import { useLocalSearchParams } from 'expo-router';

import { ShellScreen, ShellText } from '../../../src/components/ShellScreen';
import { exampleSessionQueuesMessages } from '../../../src/domain/examples';

export default function SessionScreen() {
  const { id } = useLocalSearchParams<'/sessions/[id]'>();
  return (
    <ShellScreen title="Example session" description="The transcript will appear here.">
      <ShellText>Session: {id}</ShellText>
      <ShellText>Example status: {exampleSessionQueuesMessages ? 'Waiting' : 'Ready'}</ShellText>
    </ShellScreen>
  );
}
