import { useFocusEffect, useNavigation } from 'expo-router';
import { DrawerActions } from 'expo-router/react-navigation';
import { useCallback } from 'react';

/**
 * Sessions and threads live in the drawer. The old list links (`/sessions`,
 * `/threads`) show home with the drawer open, each time they are opened.
 */
export function OpenDrawerAtHome() {
  const navigation = useNavigation();
  useFocusEffect(useCallback(() => {
    navigation.dispatch(DrawerActions.jumpTo('home'));
    navigation.dispatch(DrawerActions.openDrawer());
  }, [navigation]));
  return null;
}
