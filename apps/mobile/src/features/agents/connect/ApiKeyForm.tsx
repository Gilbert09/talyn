import { cloudProviders } from '@talyn/client/native';
import type { FleetAgent } from '@talyn/shared';
import { useState } from 'react';
import { View } from 'react-native';

import { AppText, Button, Field, Input } from '../../../components/UI';
import { trackEvent } from '../../../lib/analytics';
import { accountErrorMessage, API_KEY_KIND, API_KEY_LABEL, API_KEY_PLACEHOLDER, apiKeyError, SUBSCRIPTION } from './model';

/**
 * Add an agent account from an API key, like web's "Paste an API key". The
 * key lives only in this field's state: it is cleared on success and never
 * logged or shown again.
 */
export function ApiKeyForm({ agent, workspaceId, label, onAdded, disabled = false }: {
  agent: FleetAgent; workspaceId: string; label?: string; onAdded(): void; disabled?: boolean;
}) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const invalid = apiKeyError(agent, key);
    if (invalid) { setError(invalid); return; }
    setBusy(true); setError(null);
    try {
      await cloudProviders.fleetAccounts.add(workspaceId, agent, API_KEY_KIND[agent], key.trim(), label);
      trackEvent('cloud_provider_connected', { provider: 'selfhosted', agent });
      setKey('');
      onAdded();
    } catch (failure) {
      setError(accountErrorMessage(failure, 'Could not add the key.'));
    } finally { setBusy(false); }
  };
  return <View style={{ gap: 8 }}>
    <Field label={API_KEY_LABEL[agent]}>
      <Input accessibilityLabel={API_KEY_LABEL[agent]} value={key} onChangeText={(value) => { setKey(value); setError(null); }}
        placeholder={API_KEY_PLACEHOLDER[agent]} secureTextEntry autoCapitalize="none" autoCorrect={false} spellCheck={false}
        autoComplete="off" textContentType="none" importantForAutofill="no" editable={!busy && !disabled}
        returnKeyType="done" onSubmitEditing={() => { void submit(); }} />
    </Field>
    <AppText variant="meta" tone="muted">Billed per token, rather than against a {SUBSCRIPTION[agent]} subscription.</AppText>
    {error ? <AppText accessibilityRole="alert" variant="meta" tone="destructive">{error}</AppText> : null}
    <View style={{ alignSelf: 'flex-start' }}>
      <Button size="sm" variant="secondary" title="Add key" loading={busy} disabled={busy || disabled || !key.trim()}
        onPress={() => { void submit(); }} />
    </View>
  </View>;
}
