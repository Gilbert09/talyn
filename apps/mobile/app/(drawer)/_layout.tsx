import { Redirect, usePathname } from 'expo-router';
import { Drawer, type DrawerNavigationOptions } from 'expo-router/drawer';
import { useWindowDimensions } from 'react-native';

import { useWorkspace } from '../../src/auth/AuthProvider';
import { HomeTitle } from '../../src/features/nav/HomeScreen';
import { MenuButton } from '../../src/features/nav/MenuButton';
import { configureDrawerSwipe, DRAWER_SWIPE_EDGE, DRAWER_SWIPE_MIN_DISTANCE, drawerWidth } from '../../src/features/nav/model';
import { NavDrawer } from '../../src/features/nav/NavDrawer';
import { AppLoading } from '../../src/navigation/AppLoading';
import { OnboardingRedirect } from '../../src/navigation/OnboardingRedirect';
import { rememberIntent } from '../../src/navigation/intents';
import { workspaceGate } from '../../src/navigation/workspaceGate';
import { useTheme } from '../../src/theme/tokens';

export const unstable_settings = { initialRouteName: 'home' };

// The drawer builds its swipe with the legacy `Gesture.Pan()`, but its types name the RNGH 3 hook `PanGesture`.
const drawerSwipe = configureDrawerSwipe as unknown as DrawerNavigationOptions['configureGestureHandler'];

/** Home under a left drawer that mirrors web's sidebar. Other pages push over it on the root stack. */
export default function DrawerLayout() {
  const workspace = useWorkspace();
  const c = useTheme();
  const pathname = usePathname();
  const { width } = useWindowDimensions();
  const gate = workspaceGate(workspace);
  if (gate === 'wait') return <AppLoading phase="workspace" />;
  if (gate === 'choose') {
    rememberIntent(pathname);
    return <Redirect href="/workspaces" />;
  }
  return <OnboardingRedirect><Drawer key={workspace.selected ?? ''} backBehavior="initialRoute"
    drawerContent={({ navigation }) => <NavDrawer close={navigation.closeDrawer} />}
    screenOptions={{
      headerShown: false, drawerStyle: { width: drawerWidth(width), backgroundColor: c.paper },
      overlayColor: 'rgba(0, 0, 0, 0.4)', sceneStyle: { backgroundColor: c.background },
      swipeEdgeWidth: DRAWER_SWIPE_EDGE, swipeMinDistance: DRAWER_SWIPE_MIN_DISTANCE, configureGestureHandler: drawerSwipe,
      headerStyle: { backgroundColor: c.background }, headerShadowVisible: false, headerTintColor: c.text, headerTitleAlign: 'left',
    }}>
    <Drawer.Screen name="home" options={{ headerShown: true, title: 'Home', headerLeft: () => <MenuButton />, headerTitle: () => <HomeTitle /> }} />
    <Drawer.Screen name="sessions" options={{ swipeEnabled: false }} />
    <Drawer.Screen name="threads" options={{ swipeEnabled: false }} />
    <Drawer.Screen name="attention" options={{ swipeEnabled: false }} />
  </Drawer></OnboardingRedirect>;
}
