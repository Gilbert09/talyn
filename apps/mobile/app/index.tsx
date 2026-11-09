import { Redirect } from 'expo-router';

import { consumeIntent } from '../src/navigation/intents';
import { HOME } from '../src/navigation/routes';
import { useAuth } from '../src/auth/AuthProvider';

export default function Index() {
  const signedIn = useAuth().status === 'signedIn';
  return <Redirect href={signedIn ? consumeIntent() ?? HOME : '/sign-in'} />;
}
