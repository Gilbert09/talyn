import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';

import { Status } from './AuthControls';
import { AppText, Button, Field, Input } from './UI';
import { radius, useTheme } from '../theme/tokens';

/** Email and password form for store reviewers. A hidden gesture on the sign-in screen opens it. */
export function ReviewSignInSheet({ visible, busy, failed, onCancel, onSubmit }: {
  visible: boolean; busy: boolean; failed: boolean; onCancel(): void; onSubmit(email: string, password: string): void;
}) {
  const c = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const ready = Boolean(email.trim() && password) && !busy;
  const cancel = () => { setPassword(''); onCancel(); };
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={cancel} statusBarTranslucent>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.backdrop}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={cancel} style={StyleSheet.absoluteFill} />
      <View accessibilityViewIsModal style={[styles.sheet, { backgroundColor: c.elevated, borderColor: c.border }]}>
        <AppText accessibilityRole="header" variant="rowTitle">Review sign-in</AppText>
        {failed && !busy ? <Status message="That email and password did not work." /> : null}
        <Field label="Email">
          <Input accessibilityLabel="Email" value={email} onChangeText={setEmail} keyboardType="email-address"
            autoCapitalize="none" autoComplete="email" autoCorrect={false} editable={!busy} />
        </Field>
        <Field label="Password">
          <Input accessibilityLabel="Password" value={password} onChangeText={setPassword} secureTextEntry
            autoCapitalize="none" autoComplete="password" autoCorrect={false} editable={!busy} />
        </Field>
        <View style={styles.actions}>
          <Button variant="quiet" size="sm" title="Cancel" onPress={cancel} />
          <Button size="sm" title="Sign in" disabled={!ready} loading={busy} onPress={() => { if (ready) onSubmit(email.trim(), password); }} />
        </View>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 12, width: '100%', maxWidth: 480, alignSelf: 'center' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
