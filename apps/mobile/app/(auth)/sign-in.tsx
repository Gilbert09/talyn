import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '../../src/components/UI';
import { useAuth, useMobileRuntime, useNetwork } from '../../src/auth/AuthProvider';
import { Status } from '../../src/components/AuthControls';
import { BlinkingOwl } from '../../src/components/BootScreen';
import { ScreenContainer } from '../../src/components/ScreenContainer';
import { useShellColors } from '../../src/components/ShellScreen';
import { fonts } from '../../src/theme/tokens';

const messages = {
  invalid: 'This sign-in link is not valid. Start sign-in again.',
  expired: 'This sign-in link has expired. Start sign-in again.',
  failed: 'Sign-in could not finish. Please try again.',
  cancelled: 'Sign-in was cancelled. You can try again.',
  timeout: 'Sign-in took too long. Please try again.',
  storage: 'Secure storage is not available. Unlock this device and try again.',
  outage: 'Sign-in is temporarily unavailable. Please try again.',
};
export default function SignInScreen() {
  const colors = useShellColors();
  const auth = useAuth();
  const { auth: controller } = useMobileRuntime();
  const offline = useNetwork() === 'offline';
  const busy = auth.status === 'signingIn';
  return <ScreenContainer topInset>
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <View style={styles.hero}>
        <BlinkingOwl />
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>Talyn</Text>
        <Text style={[styles.lead, { color: colors.muted }]}>Sign in to continue. Your tasks, workspaces, and connections stay on your account.</Text>
      </View>
      <View style={styles.actions}>
        {auth.notice === 'deleted' ? <Status message="Your Talyn account data was deleted. Some provider records can remain." /> : null}
        {offline ? <Status message="You are offline. Connect to the internet, then try again." /> : null}
        {busy ? <Status message="Waiting for GitHub sign-in" loading /> : null}
        {auth.issue ? <Status message={messages[auth.issue]} /> : null}
        <Button title={busy ? 'Opening browser…' : auth.issue ? 'Try GitHub sign-in again' : 'Sign in with GitHub'}
          loading={busy} disabled={busy || offline} onPress={() => { void controller.signIn(); }} />
        {busy ? <Button variant="quiet" title="Cancel sign-in" onPress={controller.cancelSignIn} /> : null}
      </View>
      <Text style={[styles.note, { color: colors.muted }]}>A browser window opens to sign you in. You return to Talyn when you finish.</Text>
    </ScrollView>
  </ScreenContainer>;
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 32, gap: 24, width: '100%', maxWidth: 420, alignSelf: 'center' },
  hero: { alignItems: 'center', gap: 8 },
  title: { fontFamily: fonts.display[600], fontSize: 24, lineHeight: 30, letterSpacing: -0.3, marginTop: 8 },
  actions: { gap: 12 },
  lead: { fontFamily: fonts.sans[400], fontSize: 15, lineHeight: 22, textAlign: 'center' },
  note: { fontFamily: fonts.sans[400], fontSize: 12, lineHeight: 18, textAlign: 'center' },
});
