import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  compareVersions,
  filterReleaseCommits,
  gateForScope,
  GATED_FEATURE_KEYS,
  INTERNAL_SCOPES,
  isGatedFeature,
  kindForCommitType,
  highlightsForSurface,
  parseConventionalCommit,
  parseVersion,
  planWhatsNew,
  surfacesForScope,
  versionSortKey,
  whatsNewFetchFloor,
  type ReleaseHighlight,
  type ReleaseNoteEntry,
} from '@talyn/shared';
import { createTestDb } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  ingestTokenValid,
  latestReleaseNote,
  listReleaseNotes,
  parseHighlights,
  releaseIngestConfigured,
  upsertReleaseNote,
} from '../services/releaseNotes.js';

const highlight = (over: Partial<ReleaseHighlight> = {}): ReleaseHighlight => ({
  title: 'Watch a PR you did not write',
  description: 'Paste a pull request URL to track its checks alongside your own.',
  kind: 'feature',
  surfaces: ['desktop', 'web'],
  ...over,
});

const entry = (
  version: string,
  highlights: ReleaseHighlight[] = [highlight()],
  gatedFeatures: string[] = []
): ReleaseNoteEntry => ({
  version,
  publishedAt: '2026-08-30T03:00:00.000Z',
  highlights,
  gatedFeatures,
});

describe('shared/releaseNotes — versions', () => {
  it('parses X.Y.Z with or without the leading v, and rejects anything else', () => {
    expect(parseVersion('0.2.61')).toEqual({ major: 0, minor: 2, patch: 61 });
    expect(parseVersion('v0.2.61')).toEqual({ major: 0, minor: 2, patch: 61 });
    expect(parseVersion(' 1.10.0 ')).toEqual({ major: 1, minor: 10, patch: 0 });
    for (const bad of ['dev', 'web/abc1234', '0.2', '0.2.61-rc1', '', null, undefined]) {
      expect(parseVersion(bad)).toBeNull();
    }
  });

  it('orders versions numerically, not as text', () => {
    // The whole reason sort_key exists: "0.2.9" > "0.2.10" as a string.
    expect(compareVersions('0.2.9', '0.2.10')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.9.99')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.999.999')).toBeGreaterThan(0);
    expect(compareVersions('0.2.61', '0.2.61')).toBe(0);
  });

  it('keeps sort keys distinct past a thousand nightly patches', () => {
    // A 10^3 stride would collide here — Talyn ships a patch every night, so
    // three years of nightlies is a real range, not a hypothetical one.
    expect(versionSortKey('0.2.999')).toBeLessThan(versionSortKey('0.2.1000'));
    expect(versionSortKey('0.2.1000')).toBeLessThan(versionSortKey('0.3.0'));
    // ...and stays an exact integer.
    expect(Number.isSafeInteger(versionSortKey('9.999.999'))).toBe(true);
  });

  it('gives an unparseable version a key below every real one', () => {
    expect(versionSortKey('dev')).toBeLessThan(versionSortKey('0.0.0'));
  });
});

describe('shared/releaseNotes — commit filtering', () => {
  it('parses the conventional-commit shapes this repo actually produces', () => {
    // Squash-merged through the GitHub UI: carries a trailing PR number.
    expect(parseConventionalCommit('feat(desktop): adopt Liquid Glass icon for macOS 26 (#56)')).toEqual(
      {
        type: 'feat',
        scope: 'desktop',
        subject: 'adopt Liquid Glass icon for macOS 26',
        pr: 56,
        raw: 'feat(desktop): adopt Liquid Glass icon for macOS 26 (#56)',
        gate: null,
      }
    );
    // Direct push: no PR number, which is the common case here.
    expect(parseConventionalCommit('fix(settings): drop a duplicate toast import')).toMatchObject({
      type: 'fix',
      scope: 'settings',
      subject: 'drop a duplicate toast import',
      pr: null,
    });
    // No scope at all.
    expect(parseConventionalCommit('perf: batch the freshness refetch')).toMatchObject({
      type: 'perf',
      scope: null,
      subject: 'batch the freshness refetch',
    });
    // Breaking-change marker.
    expect(parseConventionalCommit('feat(api)!: drop the v0 routes')).toMatchObject({
      type: 'feat',
      scope: 'api',
      subject: 'drop the v0 routes',
    });
  });

  it('returns null for a merge commit and for prose that is not conventional', () => {
    expect(parseConventionalCommit('Merge pull request #85 from Gilbert09/tom/x')).toBeNull();
    expect(parseConventionalCommit('compare watch labels case-insensitively')).toBeNull();
    expect(parseConventionalCommit('')).toBeNull();
  });

  it('reads only the subject line of a multi-line message', () => {
    expect(
      parseConventionalCommit('feat(web): add a thing\n\nA long body that mentions fix(x): nope')
    ).toMatchObject({ type: 'feat', scope: 'web', subject: 'add a thing' });
  });

  it('keeps feat/fix/perf and drops everything else', () => {
    const kept = filterReleaseCommits([
      'feat(pr-list): watch an arbitrary PR',
      'fix(github): stop dropping check runs',
      'perf(prCache): batch the freshness refetch',
      'docs: update SESSIONS',
      'chore(deps): bump electron',
      'refactor(tasks): extract the poller',
      'test(mergeQueue): cover the stack walk',
      'style: reformat',
      'Merge pull request #85 from Gilbert09/tom/x',
    ]);
    expect(kept.map((c) => c.type)).toEqual(['feat', 'fix', 'perf']);
  });

  it('drops scopes a Talyn user cannot see from inside the app', () => {
    const kept = filterReleaseCommits([
      'feat(admin): add a cross-tenant task list',
      'fix(ci): pin the runner image',
      'feat(marketing): new pricing page',
      'feat(desktop): apply a staged update once the machine goes idle',
    ]);
    expect(kept.map((c) => c.scope)).toEqual(['desktop']);
  });

  it('TAGS a surface that is still gated rather than dropping it', () => {
    // The drop is what burnt Loops: the release was marked read with nothing
    // shown, so the real launch had nothing left to announce. A tagged commit
    // is summarised like any other and withheld downstream, where the decision
    // can be revisited every time somebody asks.
    const kept = filterReleaseCommits([
      'fix(fleet): stop dialling a stale host',
      'feat(loops): run a prompt on a schedule',
      'feat(desktop): apply a staged update once the machine goes idle',
    ]);
    expect(kept.map((c) => [c.scope, c.gate])).toEqual([
      ['fleet', 'fleet'],
      // Loops went general, so its scope stopped gating — the same transition
      // `workflows` made before it, and the reason this list is derived from
      // the register rather than written down here.
      ['loops', null],
      ['desktop', null],
    ]);
  });

  it('reads the gate off the register, so the two lists cannot drift apart', () => {
    // The predecessor was a literal array of scopes in releaseNotes.ts. It said
    // ['fleet'] on the day Loops shipped, which is the entire bug: the register
    // knew Loops was gated and the notes had their own opinion.
    expect(gateForScope('fleet')).toBe('fleet');
    expect(gateForScope('FLEET')).toBe('fleet');
    // Loops is general now; its scope answers null like any other.
    expect(gateForScope('loops')).toBeNull();
    expect(gateForScope('desktop')).toBeNull();
    expect(gateForScope(null)).toBeNull();
    // Gated and internal are opposite kinds of invisible and must not overlap:
    // an internal scope is never announced, a gated one is announced later.
    for (const key of GATED_FEATURE_KEYS) {
      expect(INTERNAL_SCOPES).not.toContain(key);
    }
  });

  it('stops tagging a feature once it is generally available', () => {
    // `workflows` and now `loops` are in the register with availability
    // 'general', so their scopes no longer gate. Were either still tagged, the
    // release that announced it to everybody would have withheld itself.
    expect(gateForScope('workflows')).toBeNull();
    expect(isGatedFeature('workflows')).toBe(false);
    expect(gateForScope('loops')).toBeNull();
    expect(isGatedFeature('loops')).toBe(false);
    // `fleet` is the one still gated, and carries the assertion loops used to.
    expect(isGatedFeature('fleet')).toBe(true);
    // An unknown key — a flag deleted from the register — is not gated. That
    // is the second way to release a feature, and it has to replay too.
    expect(isGatedFeature('a-flag-we-deleted')).toBe(false);
    expect(isGatedFeature(undefined)).toBe(false);
    expect(filterReleaseCommits(['feat(workflows): run a workflow by hand'])[0].gate).toBeNull();
  });

  it('drops our own release-notes plumbing', () => {
    // It reached the model on every release it changed in, which then correctly
    // discarded it — a turn spent on something a list entry drops for free.
    expect(filterReleaseCommits(['fix(release-notes): stop announcing gated features'])).toEqual(
      []
    );
  });

  it('maps a commit scope to the clients it can possibly affect', () => {
    expect(surfacesForScope('desktop')).toEqual(['desktop']);
    expect(surfacesForScope('web')).toEqual(['web']);
    // A backend or shared change reaches both, and so does a bare commit.
    expect(surfacesForScope('merge-queue')).toEqual(['desktop', 'web']);
    expect(surfacesForScope(null)).toEqual(['desktop', 'web']);
  });

  it('maps a commit type to a highlight kind', () => {
    expect(kindForCommitType('feat')).toBe('feature');
    expect(kindForCommitType('fix')).toBe('fix');
    expect(kindForCommitType('perf')).toBe('improvement');
  });
});

describe('shared/releaseNotes — planWhatsNew', () => {
  const base = {
    currentVersion: '0.2.63',
    surface: 'desktop' as const,
  };

  it('shows nothing on a first run, however much is available', () => {
    expect(planWhatsNew({ ...base, cursors: {}, entries: [entry('0.2.62')] }).show).toEqual([]);
    // An unparseable stored value is treated the same way: the caller
    // re-baselines rather than blasting a new user with the whole changelog.
    expect(
      planWhatsNew({ ...base, cursors: { '': 'dev' }, entries: [entry('0.2.62')] }).show
    ).toEqual([]);
  });

  it('leaves the stored cursors untouched when it shows nothing', () => {
    // The caller writes `plan.cursors` unconditionally, so a plan that declines
    // to decide must hand back exactly what it was given.
    const cursors = { '': 'dev' };
    expect(planWhatsNew({ ...base, cursors, entries: [entry('0.2.62')] }).cursors).toBe(cursors);
    expect(planWhatsNew({ ...base, cursors: { '': '0.2.63' }, entries: [] }).cursors).toEqual({
      '': '0.2.63',
    });
  });

  it('returns everything newer than the ungated cursor, newest first', () => {
    const plan = planWhatsNew({
      ...base,
      cursors: { '': '0.2.60' },
      entries: [entry('0.2.61'), entry('0.2.63'), entry('0.2.62'), entry('0.2.60')],
    });
    expect(plan.show.map((e) => e.version)).toEqual(['0.2.63', '0.2.62', '0.2.61']);
    expect(plan.cursors['']).toBe('0.2.63');
  });

  it('never shows or records a release the running build does not have yet', () => {
    // The backend knows about tonight's release the moment CI posts it; the
    // desktop user is still on last night's build. Recording 0.2.63 here would
    // swallow its notes — they would update to it and never be told.
    const plan = planWhatsNew({
      ...base,
      currentVersion: '0.2.62',
      cursors: { '': '0.2.60' },
      entries: [entry('0.2.61'), entry('0.2.62'), entry('0.2.63')],
    });
    expect(plan.show.map((e) => e.version)).toEqual(['0.2.62', '0.2.61']);
    expect(plan.cursors['']).toBe('0.2.62');
  });

  it('applies no ceiling when the client has no orderable version (the web fork)', () => {
    const plan = planWhatsNew({
      cursors: { '': '0.2.60' },
      currentVersion: null,
      surface: 'web',
      entries: [entry('0.2.61'), entry('0.2.63')],
    });
    expect(plan.show.map((e) => e.version)).toEqual(['0.2.63', '0.2.61']);
  });

  it('drops highlights for the other client, and releases thereby left empty', () => {
    const plan = planWhatsNew({
      ...base,
      cursors: { '': '0.2.60' },
      entries: [
        entry('0.2.62', [highlight({ surfaces: ['web'] })]),
        entry('0.2.61', [
          highlight({ title: 'Desktop only', surfaces: ['desktop'] }),
          highlight({ title: 'Web only', surfaces: ['web'] }),
        ]),
      ],
    });
    expect(plan.show.map((e) => e.version)).toEqual(['0.2.61']);
    expect(plan.show[0].highlights.map((h) => h.title)).toEqual(['Desktop only']);
  });

  it('records a release whose highlights were all for the other client', () => {
    // Otherwise this release is re-fetched and re-evaluated on every launch,
    // forever, and never shown.
    const plan = planWhatsNew({
      ...base,
      cursors: { '': '0.2.60' },
      entries: [entry('0.2.61', [highlight({ surfaces: ['web'] })])],
    });
    expect(plan.show).toEqual([]);
    expect(plan.cursors['']).toBe('0.2.61');
  });

  it('never walks a cursor backwards', () => {
    // The window is no longer pre-filtered to "above the cursor" — it cannot
    // be, because each stream has its own — so the newest entry in range is
    // routinely older than a cursor already past it. The desktop hits this on
    // every launch where its ceiling sits above the newest published release.
    const plan = planWhatsNew({
      ...base,
      cursors: { '': '0.2.62' },
      entries: [entry('0.2.61'), entry('0.2.62')],
    });
    expect(plan.show).toEqual([]);
    expect(plan.cursors['']).toBe('0.2.62');
  });

  it('shows nothing for a release that carried no highlights at all', () => {
    const plan = planWhatsNew({ ...base, cursors: { '': '0.2.60' }, entries: [entry('0.2.61', [])] });
    expect(plan.show).toEqual([]);
    expect(plan.cursors['']).toBe('0.2.61');
  });
});

describe('shared/releaseNotes — planWhatsNew, gated features', () => {
  const base = { currentVersion: '0.2.70', surface: 'desktop' as const };

  it('freezes a gate the first time it hears of one, at the ungated mark', () => {
    const plan = planWhatsNew({
      ...base,
      cursors: { '': '0.2.60' },
      entries: [entry('0.2.62', [highlight()], ['loops'])],
    });
    // The ungated stream moves on; the loops stream parks where it was, so
    // anything published from 0.2.61 onward is still owed to this user.
    expect(plan.cursors).toEqual({ '': '0.2.62', loops: '0.2.60' });
  });

  it('holds a frozen gate still across any number of launches', () => {
    let cursors = { '': '0.2.60' };
    for (const version of ['0.2.61', '0.2.62', '0.2.63']) {
      cursors = planWhatsNew({
        ...base,
        cursors,
        entries: [entry(version, [highlight()], ['loops'])],
      }).cursors;
    }
    expect(cursors).toEqual({ '': '0.2.63', loops: '0.2.60' });
  });

  it('freezes a gate with no content in the window', () => {
    // The reason `gatedFeatures` is the backend's whole gate set rather than
    // "what was stripped from this release": a quiet gate that advanced with
    // the ungated stream would read straight past its own launch later.
    const plan = planWhatsNew({
      ...base,
      cursors: { '': '0.2.60' },
      entries: [entry('0.2.61', [highlight()], ['loops', 'fleet'])],
    });
    expect(plan.cursors).toEqual({ '': '0.2.61', loops: '0.2.60', fleet: '0.2.60' });
  });

  it('replays the backlog on the launch after the gate comes down', () => {
    // The whole point. While `loops` was gated the backend stripped its
    // highlights and the cursor stayed at 0.2.60; the day it goes general the
    // same rows arrive tagged-but-served and render at once.
    const cursors = { '': '0.2.65', loops: '0.2.60' };
    const plan = planWhatsNew({
      ...base,
      cursors,
      entries: [
        entry('0.2.62', [highlight({ title: 'Run a prompt on a schedule', requiresFeature: 'loops' })]),
        entry('0.2.64', [highlight({ title: 'Pause a loop', requiresFeature: 'loops' })]),
        entry('0.2.66', [highlight({ title: 'Something ungated' })]),
      ],
    });
    expect(plan.show.map((e) => e.version)).toEqual(['0.2.66', '0.2.64', '0.2.62']);
    expect(plan.cursors).toEqual({ '': '0.2.66', loops: '0.2.66' });
  });

  it('does not replay what the ungated stream had already read past', () => {
    // A gate that came down before this client ever heard of it starts level
    // with the ungated cursor — no modal full of ancient history.
    const plan = planWhatsNew({
      ...base,
      cursors: { '': '0.2.65' },
      entries: [
        entry('0.2.62', [highlight({ title: 'Old gated line', requiresFeature: 'loops' })]),
        entry('0.2.66', [highlight({ title: 'New gated line', requiresFeature: 'loops' })]),
      ],
    });
    expect(plan.show.map((e) => e.highlights[0].title)).toEqual(['New gated line']);
  });

  it('keeps the streams independent', () => {
    // One gate lifting must not drag another one forward with it.
    const plan = planWhatsNew({
      ...base,
      cursors: { '': '0.2.65', loops: '0.2.60', fleet: '0.2.55' },
      entries: [
        entry('0.2.66', [highlight({ title: 'Loops', requiresFeature: 'loops' })], ['fleet']),
      ],
    });
    expect(plan.show.map((e) => e.highlights[0].title)).toEqual(['Loops']);
    expect(plan.cursors).toEqual({ '': '0.2.66', loops: '0.2.66', fleet: '0.2.55' });
  });

  it('still applies the ceiling to a replayed backlog', () => {
    const plan = planWhatsNew({
      ...base,
      currentVersion: '0.2.63',
      cursors: { '': '0.2.63', loops: '0.2.60' },
      entries: [
        entry('0.2.62', [highlight({ title: 'Have it', requiresFeature: 'loops' })]),
        entry('0.2.64', [highlight({ title: 'Do not have it', requiresFeature: 'loops' })]),
      ],
    });
    expect(plan.show.map((e) => e.highlights[0].title)).toEqual(['Have it']);
    // 0.2.64 is above the ceiling, so neither stream may record it — the user
    // updates to that build and is told about it then.
    expect(plan.cursors).toEqual({ '': '0.2.63', loops: '0.2.62' });
  });
});

describe('shared/releaseNotes — whatsNewFetchFloor', () => {
  it('asks from the OLDEST cursor, not the ungated one', () => {
    // Asking from the ungated high-water mark returns a window that cannot
    // contain the backlog a frozen gate is owed.
    expect(whatsNewFetchFloor({ '': '0.2.70', loops: '0.2.60' })).toBe('0.2.60');
    expect(whatsNewFetchFloor({ '': '0.2.70' })).toBe('0.2.70');
  });

  it('asks for everything when there is nothing to go on', () => {
    expect(whatsNewFetchFloor({})).toBeNull();
    expect(whatsNewFetchFloor({ '': 'dev' })).toBeNull();
  });
});

describe('shared/releaseNotes — highlightsForSurface', () => {
  // The Settings → About button reads the whole changelog rather than a span,
  // so it does not go through planWhatsNew. Both paths share this filter
  // so a desktop user cannot see a web-only line just because they arrived
  // from a different button.
  it('keeps only this client\'s highlights and drops releases left empty', () => {
    const filtered = highlightsForSurface(
      [
        entry('0.2.62', [highlight({ title: 'Web only', surfaces: ['web'] })]),
        entry('0.2.61', [
          highlight({ title: 'Both' }),
          highlight({ title: 'Desktop only', surfaces: ['desktop'] }),
          highlight({ title: 'Web only', surfaces: ['web'] }),
        ]),
      ],
      'desktop'
    );
    expect(filtered.map((e) => e.version)).toEqual(['0.2.61']);
    expect(filtered[0].highlights.map((h) => h.title)).toEqual(['Both', 'Desktop only']);
  });

  it('leaves the input untouched', () => {
    const input = [entry('0.2.61', [highlight({ surfaces: ['web'] })])];
    highlightsForSurface(input, 'desktop');
    expect(input[0].highlights).toHaveLength(1);
  });
});

describe('services/releaseNotes — ingest auth', () => {
  afterEach(() => {
    delete process.env.TALYN_RELEASE_INGEST_SECRET;
  });

  it('refuses everything when the secret is unset', () => {
    expect(releaseIngestConfigured()).toBe(false);
    expect(ingestTokenValid('anything')).toBe(false);
    expect(ingestTokenValid(undefined)).toBe(false);
    expect(ingestTokenValid('')).toBe(false);
  });

  it('accepts only an exact match', () => {
    process.env.TALYN_RELEASE_INGEST_SECRET = 'correct-horse-battery-staple';
    expect(releaseIngestConfigured()).toBe(true);
    expect(ingestTokenValid('correct-horse-battery-staple')).toBe(true);
    expect(ingestTokenValid('correct-horse-battery-stapl')).toBe(false); // shorter
    expect(ingestTokenValid('correct-horse-battery-staplex')).toBe(false); // longer
    expect(ingestTokenValid('Correct-Horse-Battery-Staple')).toBe(false); // case
    expect(ingestTokenValid(undefined)).toBe(false);
  });
});

describe('services/releaseNotes — parseHighlights', () => {
  it('accepts a well-formed list and trims it', () => {
    const res = parseHighlights([
      { title: '  Watch a PR  ', description: '  Track its checks.  ', kind: 'feature', surfaces: ['web', 'web'] },
    ]);
    expect(res).toEqual({
      ok: true,
      value: [
        {
          title: 'Watch a PR',
          description: 'Track its checks.',
          kind: 'feature',
          // Deduped — a doubled surface would render the line twice.
          surfaces: ['web'],
        },
      ],
    });
  });

  it('accepts an empty list — a quiet nightly is a normal outcome', () => {
    expect(parseHighlights([])).toEqual({ ok: true, value: [] });
  });

  it('keeps a gate the generator tagged, and omits the field when there is none', () => {
    const res = parseHighlights([
      { title: 'Run a prompt on a schedule', description: 'x.', kind: 'feature', surfaces: ['web'], requiresFeature: ' loops ' },
      { title: 'Untagged', description: 'y.', kind: 'fix', surfaces: ['web'], requiresFeature: null },
    ]);
    expect(res.ok).toBe(true);
    expect(res.ok && res.value[0].requiresFeature).toBe('loops');
    expect(res.ok && res.value[1]).not.toHaveProperty('requiresFeature');
  });

  it('rejects a gate the register does not know', () => {
    // A name nothing recognises would be published UNGATED, which is the exact
    // failure `requiresFeature` exists to prevent. The generator and this file
    // ship from one commit, so refusing is safe and a typo is loud.
    expect(
      parseHighlights([
        { title: 'x', description: 'y.', kind: 'fix', surfaces: ['web'], requiresFeature: 'loop' },
      ]).ok
    ).toBe(false);
    expect(
      parseHighlights([
        { title: 'x', description: 'y.', kind: 'fix', surfaces: ['web'], requiresFeature: 42 },
      ]).ok
    ).toBe(false);
  });

  it('rejects the whole payload on one malformed entry', () => {
    const bad = [
      [{ title: '', description: 'x', kind: 'fix', surfaces: ['web'] }],
      [{ title: 'x', description: '', kind: 'fix', surfaces: ['web'] }],
      [{ title: 'x', description: 'y', kind: 'refactor', surfaces: ['web'] }],
      [{ title: 'x', description: 'y', kind: 'fix', surfaces: [] }],
      [{ title: 'x', description: 'y', kind: 'fix', surfaces: ['mobile'] }],
      [{ title: 'x', description: 'y', kind: 'fix' }],
      ['not an object'],
      'not an array',
    ];
    for (const payload of bad) {
      expect(parseHighlights(payload).ok).toBe(false);
    }
    // One good entry does not rescue a bad sibling.
    expect(
      parseHighlights([highlight(), { title: 'x', description: 'y', kind: 'nope', surfaces: ['web'] }]).ok
    ).toBe(false);
  });
});

describe('services/releaseNotes — storage', () => {
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ cleanup } = await createTestDb() as { db: Database; cleanup: () => Promise<void> });
  });

  afterEach(async () => {
    await cleanup();
  });

  const publish = (version: string, day: number, highlights: ReleaseHighlight[] = [highlight()]) =>
    upsertReleaseNote({
      version,
      publishedAt: new Date(Date.UTC(2026, 7, day, 3, 0, 0)),
      highlights,
    });

  it('stores and reads a release back', async () => {
    await publish('0.2.61', 30);
    const [row] = await listReleaseNotes();
    expect(row).toEqual({
      version: '0.2.61',
      publishedAt: '2026-08-30T03:00:00.000Z',
      highlights: [highlight()],
      gatedFeatures: GATED_FEATURE_KEYS,
    });
  });

  it('withholds a gated highlight on the way out, and says which gates are up', async () => {
    // The row keeps everything the generator wrote — what changes over time is
    // the register. Filtering on the READ path is what lets the same row answer
    // differently the day the flag goes general; a write-path filter would have
    // thrown the text away and left nothing to announce.
    await publish('0.2.61', 30, [
      highlight({ title: 'Ungated' }),
      highlight({ title: 'Runs on our own hardware', requiresFeature: 'fleet' }),
      highlight({ title: 'Already released', requiresFeature: 'workflows' }),
      highlight({ title: 'Flag since deleted', requiresFeature: 'a-flag-we-deleted' }),
    ]);
    const [row] = await listReleaseNotes();
    expect(row.highlights.map((h) => h.title)).toEqual([
      'Ungated',
      'Already released',
      'Flag since deleted',
    ]);
    expect(row.gatedFeatures).toContain('fleet');
    expect(row.gatedFeatures).not.toContain('workflows');
    // Loops released, so its rows stop being withheld — the replay this whole
    // mechanism exists for.
    expect(row.gatedFeatures).not.toContain('loops');
  });

  it('withholds on the baseline read too', async () => {
    // `latest()` is the other read path — a brand-new client's baseline — and
    // it has to withhold too, or the leak just moves one endpoint over.
    await publish('0.2.61', 30, [highlight({ title: 'Gated', requiresFeature: 'fleet' })]);
    expect((await latestReleaseNote())?.highlights).toEqual([]);
  });

  it('is idempotent on version, and a re-run replaces the highlights', async () => {
    await publish('0.2.61', 30, [highlight({ title: 'First attempt' })]);
    await publish('0.2.61', 30, [highlight({ title: 'Regenerated' })]);
    const rows = await listReleaseNotes();
    expect(rows).toHaveLength(1);
    expect(rows[0].highlights[0].title).toBe('Regenerated');
  });

  it('orders newest first, numerically', async () => {
    await publish('0.2.9', 20);
    await publish('0.2.10', 21);
    await publish('0.3.0', 22);
    expect((await listReleaseNotes()).map((e) => e.version)).toEqual(['0.3.0', '0.2.10', '0.2.9']);
  });

  it('filters to releases strictly newer than `since`', async () => {
    await publish('0.2.9', 20);
    await publish('0.2.10', 21);
    await publish('0.2.11', 22);
    expect((await listReleaseNotes('0.2.9')).map((e) => e.version)).toEqual(['0.2.11', '0.2.10']);
    expect((await listReleaseNotes('0.2.11')).map((e) => e.version)).toEqual([]);
    // An unparseable stored value means "no floor" rather than an error — the
    // client's own storage is the only thing that can be malformed here.
    expect((await listReleaseNotes('dev')).map((e) => e.version)).toHaveLength(3);
  });

  it('keeps a release with no highlights, so the `since` window stays correct', async () => {
    await publish('0.2.61', 30, []);
    await publish('0.2.62', 31);
    // The quiet nightly is on record...
    expect((await listReleaseNotes()).map((e) => e.version)).toEqual(['0.2.62', '0.2.61']);
    // ...and a client sitting on it still gets told about the next one.
    expect((await listReleaseNotes('0.2.61')).map((e) => e.version)).toEqual(['0.2.62']);
  });

  it('returns the newest release for the first-run baseline, or null on an empty table', async () => {
    expect(await latestReleaseNote()).toBeNull();
    await publish('0.2.9', 20);
    await publish('0.2.10', 21);
    expect((await latestReleaseNote())?.version).toBe('0.2.10');
  });
});
