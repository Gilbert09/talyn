import { MENU_COMMANDS, toAccelerator } from '../main/menuCommands';
import {
  MAX_ZOOM_FACTOR,
  MIN_ZOOM_FACTOR,
  ZOOM_FACTORS,
  formatZoomPercent,
  isZoomStep,
  nextZoomFactor,
  parseZoomFactor,
  zoomAliasForInput,
  type ZoomInput,
} from '../main/zoomSteps';

describe('nextZoomFactor', () => {
  it.each([
    [1, 'in', 1.1],
    [1, 'out', 0.9],
    [1.1, 'in', 1.25],
    [0.9, 'out', 0.8],
    [0.67, 'out', 0.5],
    [MAX_ZOOM_FACTOR, 'in', MAX_ZOOM_FACTOR],
    [MIN_ZOOM_FACTOR, 'out', MIN_ZOOM_FACTOR],
    [1.75, 'reset', 1],
    [0.5, 'reset', 1],
    // Between two steps: go to the nearer step in that direction.
    [1.05, 'in', 1.1],
    [1.05, 'out', 1],
    // Outside the range: clamp.
    [5, 'in', MAX_ZOOM_FACTOR],
    [5, 'out', MAX_ZOOM_FACTOR],
    [0.1, 'out', MIN_ZOOM_FACTOR],
    [0.1, 'in', MIN_ZOOM_FACTOR],
    [Number.NaN, 'in', 1],
  ] as const)('%s %s → %s', (current, step, expected) => {
    expect(nextZoomFactor(current, step)).toBe(expected);
  });

  it('walks every step up and back down', () => {
    let f = MIN_ZOOM_FACTOR as number;
    const up: number[] = [f];
    while (f < MAX_ZOOM_FACTOR) {
      f = nextZoomFactor(f, 'in');
      up.push(f);
    }
    expect(up).toEqual([...ZOOM_FACTORS]);
    const down: number[] = [f];
    while (f > MIN_ZOOM_FACTOR) {
      f = nextZoomFactor(f, 'out');
      down.push(f);
    }
    expect(down).toEqual([...ZOOM_FACTORS].reverse());
  });
});

describe('parseZoomFactor', () => {
  it.each([
    [1.25, 1.25],
    [0.5, 0.5],
    [2, 2],
    [1.05, 1.05],
    [undefined, 1],
    [null, 1],
    ['1.5', 1],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
    [0, 1],
    [-1, 1],
    [0.2, 1],
    [3, 1],
  ])('%p → %p', (raw, expected) => {
    expect(parseZoomFactor(raw)).toBe(expected);
  });
});

describe('isZoomStep', () => {
  it.each([
    ['in', true],
    ['out', true],
    ['reset', true],
    ['IN', false],
    ['', false],
    [1, false],
    [null, false],
    [undefined, false],
  ])('%p → %p', (value, expected) => {
    expect(isZoomStep(value)).toBe(expected);
  });
});

describe('formatZoomPercent', () => {
  it.each([
    [1, '100%'],
    [0.67, '67%'],
    [1.25, '125%'],
    [2, '200%'],
  ])('%p → %p', (factor, expected) => {
    expect(formatZoomPercent(factor)).toBe(expected);
  });
});

describe('zoomAliasForInput', () => {
  const input = (over: Partial<ZoomInput>): ZoomInput => ({
    type: 'keyDown',
    key: '',
    code: '',
    meta: false,
    control: false,
    alt: false,
    ...over,
  });

  it.each([
    // macOS: ⌘ is the modifier.
    [true, { meta: true, key: '+', code: 'Equal' }, 'in'],
    [true, { meta: true, key: '_', code: 'Minus' }, 'out'],
    [true, { meta: true, key: '+', code: 'NumpadAdd' }, 'in'],
    [true, { meta: true, key: '-', code: 'NumpadSubtract' }, 'out'],
    [true, { meta: true, key: '0', code: 'Numpad0' }, 'reset'],
    [true, { control: true, key: '+', code: 'Equal' }, null],
    [true, { meta: true, control: true, key: '+', code: 'Equal' }, null],
    // Windows and Linux: Ctrl is the modifier.
    [false, { control: true, key: '+', code: 'Equal' }, 'in'],
    [false, { control: true, key: '_', code: 'Minus' }, 'out'],
    [false, { control: true, key: '+', code: 'NumpadAdd' }, 'in'],
    [false, { control: true, key: '-', code: 'NumpadSubtract' }, 'out'],
    [false, { control: true, key: '0', code: 'Numpad0' }, 'reset'],
    [false, { control: true, key: 'Insert', code: 'Numpad0' }, null],
    [false, { meta: true, key: '+', code: 'Equal' }, null],
    // The menu owns the plain chords.
    [true, { meta: true, key: '=', code: 'Equal' }, null],
    [true, { meta: true, key: '-', code: 'Minus' }, null],
    [true, { meta: true, key: '0', code: 'Digit0' }, null],
    // No modifier, Alt, or a key release.
    [true, { key: '+', code: 'Equal' }, null],
    [true, { meta: true, alt: true, key: '+', code: 'Equal' }, null],
    [true, { type: 'keyUp', meta: true, key: '+', code: 'Equal' }, null],
  ] as const)('mac=%s %p → %p', (mac, over, expected) => {
    expect(zoomAliasForInput(input(over), mac)).toBe(expected);
  });
});

describe('zoom menu commands', () => {
  it.each([
    ['view.zoomIn', 'mod+=', 'CmdOrCtrl+='],
    ['view.zoomOut', 'mod+-', 'CmdOrCtrl+-'],
    ['view.zoomReset', 'mod+0', 'CmdOrCtrl+0'],
  ])('%s owns %s in the View menu', (id, keys, accelerator) => {
    const command = MENU_COMMANDS.find((c) => c.id === id);
    expect(command).toMatchObject({ keys, section: 'view' });
    expect(command?.rendererOnly).toBeFalsy();
    expect(toAccelerator(keys)).toBe(accelerator);
  });
});
