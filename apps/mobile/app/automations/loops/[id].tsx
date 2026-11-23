import { Redirect, useLocalSearchParams } from 'expo-router';

export default function Screen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Redirect href={{ pathname: '/integrations/[kind]/[id]', params: { kind: 'schedule', id } }} />;
}
