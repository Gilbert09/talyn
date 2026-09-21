/**
 * jsdom gaps that real browsers provide.
 *
 * `matchMedia` is used at module scope by stores/workspace.ts to follow the
 * system colour scheme, so importing anything that touches the store throws
 * without this. Stubbed rather than mocked per-test: it is environment, not
 * behaviour under test.
 */
// `crypto.randomUUID` exists in every browser we target, but only in a SECURE
// CONTEXT — https, or localhost. Both the deployed app and local dev qualify,
// so this is purely a jsdom gap, not something production has to guard.
if (!globalThis.crypto?.randomUUID) {
  const uuid = () =>
    '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
      (
        Number(c) ^
        (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))
      ).toString(16)
    );
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: uuid });
}

/**
 * `localStorage`, which jsdom does provide — but Node 22 ships its own global
 * `localStorage` that shadows it and throws on every method unless the runtime
 * was started with a valid `--localstorage-file`. Anything importing
 * `stores/workspace` reads it at module scope (theme, workspace preference),
 * so without this the import itself throws and the suite reports zero tests
 * rather than a failure you can read.
 *
 * Probed rather than feature-detected: the broken one IS present, so
 * `if (!localStorage)` would not catch it.
 */
function localStorageWorks(): boolean {
  try {
    globalThis.localStorage.getItem('probe');
    return true;
  } catch {
    return false;
  }
}

if (!localStorageWorks()) {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
