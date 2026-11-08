import { Redirect } from 'expo-router';

import { useAuth } from '../src/auth/AuthProvider';

export default function Index() {
  return <Redirect href={useAuth().status === 'signedIn' ? '/sessions' : '/sign-in'} />;
}
