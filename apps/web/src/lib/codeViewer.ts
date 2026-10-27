/** The parts of a Monaco language registration that pick a language from a file name. */
export interface LanguageMatchInfo {
  id: string;
  extensions?: string[];
  filenames?: string[];
  filenamePatterns?: string[];
}

/**
 * Monaco's Monarch grammars have no JSON (JSON lives in the language service,
 * which needs its own worker), so the viewer registers a small one itself.
 */
export const JSON_LANGUAGE: LanguageMatchInfo = {
  id: 'json',
  extensions: ['.json', '.jsonc', '.json5', '.har', '.babelrc', '.eslintrc', '.jshintrc', '.prettierrc', '.code-workspace'],
};

function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .toLowerCase()
    .split('')
    .map((ch) => (ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`);
}

/**
 * The language id for a file, matched the way VS Code does it: an exact file
 * name first, then a file name pattern, then the longest matching extension.
 * Matching ignores case. No match gives `plaintext`.
 */
export function languageForPath(path: string, languages: readonly LanguageMatchInfo[]): string {
  const lowerPath = path.toLowerCase();
  const name = lowerPath.slice(lowerPath.lastIndexOf('/') + 1);
  if (!name) return 'plaintext';

  for (const lang of languages) {
    if (lang.filenames?.some((f) => f.toLowerCase() === name)) return lang.id;
  }
  for (const lang of languages) {
    const hit = lang.filenamePatterns?.some((p) => globToRegExp(p).test(p.includes('/') ? lowerPath : name));
    if (hit) return lang.id;
  }
  let best: { id: string; length: number } | null = null;
  for (const lang of languages) {
    for (const ext of lang.extensions ?? []) {
      const lower = ext.toLowerCase();
      if (name.endsWith(lower) && (!best || lower.length > best.length)) best = { id: lang.id, length: lower.length };
    }
  }
  return best?.id ?? 'plaintext';
}

/** `40 43% 98%` (the app's HSL color tokens) to `#fcfbf8`. Null when the value does not parse. */
export function hslTokenToHex(token: string): string | null {
  const m = token.trim().match(/^(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%$/);
  if (!m) return null;
  const h = (((Number(m[1]) % 360) + 360) % 360) / 360;
  const s = Math.min(100, Number(m[2])) / 100;
  const l = Math.min(100, Number(m[3])) / 100;
  const hue = (p: number, q: number, t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  let r = l;
  let g = l;
  let b = l;
  if (s > 0) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3);
    g = hue(p, q, h);
    b = hue(p, q, h - 1 / 3);
  }
  return `#${[r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
}
