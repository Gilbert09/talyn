import { usePreventRemove } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';

/** The guard's question. Exported so tests and screens use one copy. */
export const DISCARD_TITLE = 'Discard changes?';

/**
 * Asks before the screen closes while `dirty` is true: the back button, the
 * back gesture and a route change all stop here. "Keep editing" stays on the
 * screen; "Discard" leaves it. Web asks the same before it drops a draft.
 *
 * `leave(go)` turns the guard off and then runs `go` on the next render, for
 * a screen that leaves on purpose (after a delete, say) while still dirty.
 */
export function useUnsavedGuard(dirty: boolean, message = 'Your changes are not saved.', title = DISCARD_TITLE) {
  const [leaving, setLeaving] = useState(false);
  const next = useRef<(() => void) | null>(null);
  usePreventRemove(dirty && !leaving, ({ repeat }) => {
    Alert.alert(title, message, [
      { text: title === DISCARD_TITLE ? 'Keep editing' : 'Stay', style: 'cancel', isPreferred: true },
      { text: title === DISCARD_TITLE ? 'Discard' : 'Leave', style: 'destructive', onPress: () => { next.current = repeat; setLeaving(true); } },
    ]);
  });
  useEffect(() => {
    if (!leaving || !next.current) return;
    const go = next.current;
    next.current = null;
    go();
  }, [leaving]);
  const leave = useCallback((go: () => void) => { next.current = go; setLeaving(true); }, []);
  return { leave };
}
