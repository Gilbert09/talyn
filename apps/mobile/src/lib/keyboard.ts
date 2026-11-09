import { useContext, useEffect, useState } from 'react';
import { Dimensions, Keyboard, Platform } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

/**
 * The keyboard's top edge in screen coordinates while it is open, and null when
 * it is closed. iOS reports before the animation, Android after it.
 */
export function useKeyboardTop() {
  const [top, setTop] = useState<number | null>(null);
  useEffect(() => {
    const show = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hide = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const shown = Keyboard.addListener(show, (event) => setTop(event.endCoordinates.screenY));
    const hidden = Keyboard.addListener(hide, () => setTop(null));
    return () => { shown.remove(); hidden.remove(); };
  }, []);
  return top;
}

/**
 * Bottom space that keeps content above the keyboard on an edge-to-edge
 * Android screen, where the window does not resize and `KeyboardAvoidingView`
 * cannot measure the overlap. The overlap comes from the keyboard's top edge,
 * because the reported height leaves out the navigation bar on some devices.
 * The screen already pads the navigation bar, so that part is not added twice.
 */
export function keyboardInset(keyboardTop: number | null, screenHeight: number, bottomInset: number) {
  if (keyboardTop === null) return 0;
  return Math.max(0, Math.round(screenHeight - keyboardTop - bottomInset));
}

export function useKeyboardInset() {
  const top = useKeyboardTop();
  const bottom = useContext(SafeAreaInsetsContext)?.bottom ?? 0;
  return { open: top !== null, inset: keyboardInset(top, Dimensions.get('screen').height, bottom) };
}
