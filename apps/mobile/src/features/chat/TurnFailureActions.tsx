import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';

import { useMobileRuntime } from '../../auth/AuthProvider';
import { Button } from '../../components/UI';
import { chatActions } from './actions';

export function TurnFailureActions({ chatId, workbenchId, text, reconnect, disabled = false }: {
  chatId: string; workbenchId: string; text: string; reconnect: boolean; disabled?: boolean;
}) {
  const router = useRouter();
  const { workflow } = useMobileRuntime();
  const [sending, setSending] = useState(false);
  const retry = async () => {
    if (sending || disabled) return;
    setSending(true);
    try {
      await chatActions.send(chatId, { text: `Continue from where you stopped. The last turn ended with an error: ${text.trim().slice(0, 300)}.` });
      workflow.refresh('workbench', workbenchId);
      workflow.refresh('transcript', chatId);
    } catch (error) {
      Alert.alert('Could not retry the turn', error instanceof Error ? error.message : 'Try again.');
    } finally { setSending(false); }
  };
  return <View style={{ flexDirection: 'row', gap: 8 }}>
    <Button size="sm" variant="quiet" title="Retry" disabled={disabled || sending} onPress={() => { void retry(); }} />
    {reconnect ? <Button size="sm" variant="quiet" title="Reconnect" onPress={() => router.push('/agents')} /> : null}
  </View>;
}
