import type { ReleaseHighlight, ReleaseNoteEntry } from '@talyn/shared';
import { render, screen } from '@testing-library/react-native';

import { mobileReleaseNotes, releaseDateLabel } from '../features/whatsNew/model';
import { WhatsNewScreen } from '../features/whatsNew/WhatsNewScreen';
import { fixture } from './workflowFixtures';

const mockLifecycle = fixture().lifecycle;
const mockList = jest.fn();

jest.mock('@talyn/client/native', () => ({ releaseNotes: { list: (...args: unknown[]) => mockList(...args) } }));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ lifecycle: mockLifecycle }),
  useNetwork: () => 'online',
}));

const highlight = (title: string, surfaces: ReleaseHighlight['surfaces'], over: Partial<ReleaseHighlight> = {}): ReleaseHighlight => ({
  title, description: `${title} description.`, kind: 'feature', surfaces, ...over,
});
const entry = (version: string, publishedAt: string, highlights: ReleaseHighlight[]): ReleaseNoteEntry => ({
  version, publishedAt, highlights, gatedFeatures: [],
});

const FEED = [
  entry('0.3.9', '2026-11-09T03:00:00.000Z', [
    highlight('Swipe back on Android', ['mobile'], { kind: 'fix' }),
    highlight('Split view in sessions', ['desktop', 'web']),
  ]),
  entry('0.3.10', '2026-11-10T03:00:00.000Z', [highlight('Desktop tray icon', ['desktop'])]),
  entry('0.3.11', '2026-11-11T03:00:00.000Z', [
    highlight('Sandbox start progress', ['mobile']),
    highlight('Faster sign in', ['desktop', 'web', 'mobile'], { kind: 'improvement' }),
  ]),
];

describe('mobileReleaseNotes', () => {
  it('keeps only mobile highlights, newest release first, and drops releases left empty', () => {
    const notes = mobileReleaseNotes(FEED);
    expect(notes.map((e) => e.version)).toEqual(['0.3.11', '0.3.9']);
    expect(notes[0]!.highlights.map((h) => h.title)).toEqual(['Sandbox start progress', 'Faster sign in']);
    expect(notes[1]!.highlights.map((h) => h.title)).toEqual(['Swipe back on Android']);
  });

  it.each([[undefined], [null], [[]]])('returns nothing for %j', (input) => {
    expect(mobileReleaseNotes(input)).toEqual([]);
  });

  it('does not reorder the input', () => {
    const input = [...FEED];
    mobileReleaseNotes(input);
    expect(input.map((e) => e.version)).toEqual(['0.3.9', '0.3.10', '0.3.11']);
  });
});

describe('releaseDateLabel', () => {
  it.each([
    ['2026-11-11T12:00:00.000Z', '11 Nov 2026'],
    ['2026-01-05T12:00:00.000Z', '5 Jan 2026'],
    ['not a date', 'Release'],
  ])('labels %s as %s', (iso, label) => {
    expect(releaseDateLabel(iso)).toBe(label);
  });
});

describe('WhatsNewScreen', () => {
  beforeEach(() => { mockList.mockReset(); });

  it('shows the mobile highlights and hides desktop and web ones', async () => {
    mockList.mockResolvedValue(FEED);
    await render(<WhatsNewScreen />);
    expect(await screen.findByText('Sandbox start progress')).toBeTruthy();
    expect(screen.getByText('Swipe back on Android')).toBeTruthy();
    expect(screen.getByText('Faster sign in')).toBeTruthy();
    expect(screen.getByText('Improved')).toBeTruthy();
    expect(screen.getByText('Fixed')).toBeTruthy();
    expect(screen.queryByText('Split view in sessions')).toBeNull();
    expect(screen.queryByText('Desktop tray icon')).toBeNull();
    expect(mockList).toHaveBeenCalledWith();
  });

  it('says so when no release has mobile notes', async () => {
    mockList.mockResolvedValue([entry('0.3.10', '2026-11-10T03:00:00.000Z', [highlight('Desktop tray icon', ['desktop'])])]);
    await render(<WhatsNewScreen />);
    expect(await screen.findByText('Nothing new yet')).toBeTruthy();
    expect(screen.queryByText('Desktop tray icon')).toBeNull();
  });
});
