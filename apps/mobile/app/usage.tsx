import { Redirect } from 'expo-router';

// Usage is part of the plan page now. Old links and the nav entry still land here.
export default function Screen() {
  return <Redirect href="/billing" />;
}
