import { Stack } from 'expo-router';

import { OnboardingGuard } from '../../src/features/onboarding/OnboardingScreens';
import { useTheme } from '../../src/theme/tokens';

/** Full-screen setup steps with no navigation header. Each step draws its own heading and footer. */
export default function OnboardingLayout() {
  const c = useTheme();
  return <OnboardingGuard>
    <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right', contentStyle: { backgroundColor: c.background } }} />
  </OnboardingGuard>;
}
