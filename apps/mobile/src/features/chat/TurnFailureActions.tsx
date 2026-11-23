import { agentOutageFrom } from '@talyn/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, View } from 'react-native';

import { useMobileRuntime } from '../../auth/AuthProvider';
import { AppText, Button } from '../../components/UI';
import { chatActions } from './actions';

export function TurnFailureActions({ chatId, workbenchId, text, reconnect, resumeAt, resumeReason, disabled = false }: {
  chatId: string; workbenchId: string; text: string; reconnect: boolean; disabled?: boolean;
  resumeAt?: string | null; resumeReason?: string | null;
}) {
  const router = useRouter();
  const { workflow } = useMobileRuntime();
  const [sending, setSending] = useState(false);
  const retry = async () => {
    if (sending || disabled) return;
    setSending(true);
    try {
      await chatActions.send(chatId, { text: `Continue from where you stopped. The last turn ended with an error: ${(resumeReason || text).trim().slice(0, 300)}.` });
      workflow.refresh('workbench', workbenchId);
      workflow.refresh('transcript', chatId);
    } catch (error) {
      Alert.alert('Could not retry the turn', error instanceof Error ? error.message : 'Try again.');
    } finally { setSending(false); }
  };
  const cancel = async () => {
    if (sending || disabled) return;
    setSending(true);
    try {
      await chatActions.cancelResume(chatId);
      workflow.refresh('workbench', workbenchId);
    } catch (error) {
      Alert.alert('Could not cancel the wait', error instanceof Error ? error.message : 'Try again.');
    } finally { setSending(false); }
  };
  if (resumeAt) {
    const at = new Date(resumeAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    const message = `${reconnect ? 'Waiting for the account to be signed in again. Checks again at' : agentOutageFrom(resumeReason) ? 'The model API is failing. The box is suspended until Talyn tries again at' : 'Waiting for usage. Resumes at'} ${at}.`;
    return <View style={{ gap: 8 }}>
      <AppText variant="caption" tone="muted">{message}</AppText>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button size="sm" variant="quiet" title="Resume now" disabled={disabled || sending} onPress={() => { void retry(); }} />
        <Button size="sm" variant="quiet" title="Cancel" disabled={disabled || sending} onPress={() => { void cancel(); }} />
      </View>
    </View>;
  }
  return <View style={{ flexDirection: 'row', gap: 8 }}>
    <Button size="sm" variant="quiet" title="Retry" disabled={disabled || sending} onPress={() => { void retry(); }} />
    {reconnect ? <Button size="sm" variant="quiet" title="Reconnect" onPress={() => router.push('/agents')} /> : null}
  </View>;
}
