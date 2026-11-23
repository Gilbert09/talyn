import { Redirect, useLocalSearchParams } from 'expo-router';

export default function Screen() {
  const { id, kind } = useLocalSearchParams<{ id: string; kind?: string }>();
  if (id === 'loops') return <Redirect href="/integrations/schedule" />;
  if (id === 'workflows') return <Redirect href="/integrations/github" />;
  return <Redirect href={{ pathname: '/integrations/[kind]/[id]', params: { kind: kind === 'loop' ? 'schedule' : 'github', id } }} />;
}
