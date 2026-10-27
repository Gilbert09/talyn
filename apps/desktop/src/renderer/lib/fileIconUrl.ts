import { iconModuleUrl, type IconModule } from './fileIcons';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface Require {
      context(dir: string, deep: boolean, filter: RegExp, mode: 'lazy-once'): {
        (key: string): Promise<IconModule>;
        keys(): string[];
      };
    }
  }
}

// lazy-once puts every icon URL in one chunk that loads on first use; the SVGs
// themselves stay separate assets (see the material-icon-theme rule in webpack).
const icons = require.context('material-icon-theme/icons', false, /\.svg$/, 'lazy-once');
const known = new Set(icons.keys());
const cache = new Map<string, Promise<string | null>>();

export function loadFileIconUrl(name: string): Promise<string | null> {
  const key = `./${name}.svg`;
  if (!known.has(key)) return Promise.resolve(null);
  const cached = cache.get(name);
  if (cached) return cached;
  const hit = icons(key).then(iconModuleUrl, () => null);
  cache.set(name, hit);
  return hit;
}
