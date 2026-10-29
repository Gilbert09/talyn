// Standard emoji for the Slack trigger picker, matched to Slack's shortcodes.
//
// The dataset (emojibase-data: names + the iamcal shortcode map Slack uses) is
// about 600 KB of JSON, so it sits behind a dynamic import and is fetched the
// first time a Slack card renders. Nothing else in the app pays for it.

export interface StandardEmoji {
  /** Primary Slack shortcode, e.g. `thumbsup`. */
  name: string;
  /** Every shortcode Slack accepts for this emoji, primary first. */
  aliases: string[];
  glyph: string;
  label: string;
  tags: string[];
}

interface CompactEmoji {
  hexcode: string;
  label: string;
  unicode: string;
  tags?: string[];
  group?: number;
}

export interface StandardEmojiIndex {
  list: StandardEmoji[];
  /** Any shortcode → its glyph. */
  glyphs: Map<string, string>;
}

let loading: Promise<StandardEmojiIndex> | null = null;

/** Build the index from the two datasets. Exported for tests. */
export function buildStandardEmojiIndex(
  compact: CompactEmoji[],
  shortcodes: Record<string, string | string[]>
): StandardEmojiIndex {
  const list: StandardEmoji[] = [];
  const glyphs = new Map<string, string>();
  for (const e of compact) {
    // Group 2 is skin-tone and hair components; they are not reactions.
    if (e.group === undefined || e.group === 2) continue;
    const raw = shortcodes[e.hexcode];
    if (!raw) continue;
    const aliases = Array.isArray(raw) ? raw : [raw];
    list.push({ name: aliases[0], aliases, glyph: e.unicode, label: e.label, tags: e.tags ?? [] });
    for (const a of aliases) if (!glyphs.has(a)) glyphs.set(a, e.unicode);
  }
  return { list, glyphs };
}

export function loadStandardEmoji(): Promise<StandardEmojiIndex> {
  if (!loading) {
    loading = Promise.all([
      import('emojibase-data/en/compact.json'),
      import('emojibase-data/en/shortcodes/iamcal.json'),
    ])
      .then(([compact, shortcodes]) =>
        buildStandardEmojiIndex(
          (compact.default ?? compact) as unknown as CompactEmoji[],
          (shortcodes.default ?? shortcodes) as unknown as Record<string, string | string[]>
        )
      )
      .catch((e) => {
        loading = null;
        throw e;
      });
  }
  return loading;
}

export interface PickerEntry {
  name: string;
  /** Present for a standard emoji. */
  glyph?: string;
  /** Present for a workspace custom emoji. */
  url?: string;
  label: string;
  /** Every shortcode that names this emoji, for hiding ones already chosen. */
  aliases: string[];
}

/**
 * Entries matching `query` (name, alias, label or tag). The workspace's custom
 * emoji come first. An empty query returns everything; callers cap the draw.
 */
export function searchEmoji(
  index: StandardEmojiIndex | null,
  custom: { name: string; url: string }[],
  query: string
): PickerEntry[] {
  const q = query.trim().toLowerCase().replace(/^:+|:+$/g, '');
  const customEntries: PickerEntry[] = custom
    .filter((c) => !q || c.name.includes(q))
    .map((c) => ({ name: c.name, url: c.url, label: c.name, aliases: [c.name] }));
  const standard: PickerEntry[] = [];
  const exact: PickerEntry[] = [];
  for (const e of index?.list ?? []) {
    if (
      q &&
      !e.aliases.some((a) => a.includes(q)) &&
      !e.label.toLowerCase().includes(q) &&
      !e.tags.some((t) => t.toLowerCase().includes(q))
    ) {
      continue;
    }
    const entry = { name: e.name, glyph: e.glyph, label: e.label, aliases: e.aliases };
    (e.aliases.includes(q) ? exact : standard).push(entry);
  }
  return [...customEntries, ...exact, ...standard];
}
