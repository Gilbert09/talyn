/**
 * Postgres jsonb and text reject U+0000, and jsonb rejects an unpaired UTF-16
 * surrogate. Agent output can carry either, and one bad character would fail
 * the same batch on every retry. These helpers replace them with U+FFFD.
 */
const REPLACEMENT = '�';
// A lone surrogate is a high not followed by a low, or a low not preceded by a high.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// eslint-disable-next-line no-control-regex
const NEEDS_CLEANING = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function cleanJsonbString(value: string): string {
  if (!NEEDS_CLEANING.test(value)) return value;
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u0000/g, REPLACEMENT).replace(LONE_SURROGATE, REPLACEMENT);
}

/** Deep-clean strings and object keys. Returns the same reference when nothing needs cleaning. */
export function toJsonbSafe<T>(value: T): T {
  if (typeof value === 'string') return cleanJsonbString(value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const clean = toJsonbSafe(item);
      if (clean !== item) changed = true;
      return clean;
    });
    return (changed ? out : value) as T;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      const cleanKey = cleanJsonbString(key);
      const clean = toJsonbSafe(item);
      if (cleanKey !== key || clean !== item) changed = true;
      out[cleanKey] = clean;
    }
    return (changed ? out : value) as T;
  }
  return value;
}

/**
 * JSON.stringify for a jsonb parameter. The serialized form escapes U+0000 as
 * `\u0000` and a lone surrogate as `\ud8xx`, so the cheap check runs on that text
 * and the deep walk runs only when it finds one.
 */
export function stringifyJsonbSafe(value: unknown): string {
  const text = JSON.stringify(value);
  if (!/\\u0000|\\u[dD][89a-fA-F][0-9a-fA-F]{2}/.test(text)) return text;
  return JSON.stringify(toJsonbSafe(value));
}
