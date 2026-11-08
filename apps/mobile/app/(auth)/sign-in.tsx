import { Button } from 'react-native';

import { useAuth, useMobileRuntime, useNetwork } from '../../src/auth/AuthProvider';
import { Status } from '../../src/components/AuthControls';
import { ShellScreen } from '../../src/components/ShellScreen';

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
  const auth = useAuth();
  const { auth: controller } = useMobileRuntime();
  const offline = useNetwork() === 'offline';
  const busy = auth.status === 'signingIn';
  return <ShellScreen title="Sign in to Talyn" description="Continue with your existing GitHub account.">
    {auth.notice === 'deleted' ? <Status message="Your Talyn account data was deleted. Some provider records can remain." /> : null}
    {offline ? <Status message="You are offline. Connect to the internet, then try again." /> : null}
    {busy ? <Status message="Waiting for GitHub sign-in" loading /> : null}
    {auth.issue ? <Status message={messages[auth.issue]} /> : null}
    <Button title={auth.issue ? 'Try GitHub sign-in again' : 'Continue with GitHub'}
      disabled={busy || offline} onPress={() => { void controller.signIn(); }} />
    {busy ? <Button title="Cancel sign-in" onPress={controller.cancelSignIn} /> : null}
  </ShellScreen>;
}
