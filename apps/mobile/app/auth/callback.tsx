import { useRouter } from 'expo-router';
import { useEffect } from 'react';

import { Status } from '../../src/components/AuthControls';
import { ShellScreen } from '../../src/components/ShellScreen';

export default function CallbackScreen() {
  const router = useRouter();
  useEffect(() => { router.replace('/'); }, [router]);
  return <ShellScreen title="Completing sign-in" description="Checking your sign-in securely."><Status message="Completing sign-in" loading /></ShellScreen>;
}
