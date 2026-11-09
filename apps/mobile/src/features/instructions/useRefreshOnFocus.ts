import { useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';

/** Refetch when the screen comes back into view, such as after an editor closes. The first focus is skipped: the screen loads on mount. */
export function useRefreshOnFocus(refresh: () => void) {
  const first = useRef(true);
  const latest = useRef(refresh);
  latest.current = refresh;
  useFocusEffect(useCallback(() => {
    if (first.current) { first.current = false; return; }
    latest.current();
  }, []));
}
