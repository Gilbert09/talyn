import { Redirect } from 'expo-router';
import { useEffect, type PropsWithChildren } from 'react';

import { AppLoading } from './AppLoading';
import { useOnboardingGate } from './useOnboardingGate';

/**
 * Home's setup check. A workspace that is not set up opens onboarding; a
 * returning one draws home at once. A finished setup clears the device's
 * "in progress" mark, so removing every repository later does not reopen it.
 */
export function OnboardingRedirect({ children }: PropsWithChildren) {
  const { gate, progress } = useOnboardingGate();
  const { inProgress, finish } = progress;
  useEffect(() => { if (gate === 'done' && inProgress) finish(); }, [gate, inProgress, finish]);
  if (gate === 'loading') return <AppLoading phase="workspace" />;
  if (gate !== 'done') return <Redirect href="/onboarding" />;
  return <>{children}</>;
}
