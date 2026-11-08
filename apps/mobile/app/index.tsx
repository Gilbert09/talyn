import { Redirect } from 'expo-router';

import { consumeIntent } from '../src/navigation/intents';
import { useAuth } from '../src/auth/AuthProvider';

export default function Index() {
  const signedIn = useAuth().status === 'signedIn';
  return <Redirect href={signedIn ? consumeIntent() ?? '/sessions' : '/sign-in'} />;
}
