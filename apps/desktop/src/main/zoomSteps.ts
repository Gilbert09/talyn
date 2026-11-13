/**
 * Window zoom, the VS Code way: ⌘= / ⌘- / ⌘0 make the whole window bigger,
 * smaller or back to normal.
 *
 * Pure data, no Electron import: the renderer reads it too.
 */

/** The browser's own zoom steps, so one press is a small change. */
export const ZOOM_FACTORS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

export const DEFAULT_ZOOM_FACTOR = 1;
export const MIN_ZOOM_FACTOR = ZOOM_FACTORS[0];
export const MAX_ZOOM_FACTOR = ZOOM_FACTORS[ZOOM_FACTORS.length - 1];

export type ZoomStep = 'in' | 'out' | 'reset';

export const ZOOM_GET_CHANNEL = 'app:zoom:get';
export const ZOOM_STEP_CHANNEL = 'app:zoom:step';
export const ZOOM_CHANGED_CHANNEL = 'app:zoom:changed';

const EPSILON = 0.001;

export function isZoomStep(value: unknown): value is ZoomStep {
  return value === 'in' || value === 'out' || value === 'reset';
}

/** The factor one step away. A factor between two steps moves to the nearer step in that direction. */
export function nextZoomFactor(current: number, step: ZoomStep): number {
  if (step === 'reset' || !Number.isFinite(current)) return DEFAULT_ZOOM_FACTOR;
  if (step === 'in') return ZOOM_FACTORS.find((f) => f > current + EPSILON) ?? MAX_ZOOM_FACTOR;
  return [...ZOOM_FACTORS].reverse().find((f) => f < current - EPSILON) ?? MIN_ZOOM_FACTOR;
}

/** A saved factor, or the default when it is missing, not a number or out of range. */
export function parseZoomFactor(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_ZOOM_FACTOR;
  if (raw < MIN_ZOOM_FACTOR - EPSILON || raw > MAX_ZOOM_FACTOR + EPSILON) return DEFAULT_ZOOM_FACTOR;
  return raw;
}

export function formatZoomPercent(factor: number): string {
  return `${Math.round(factor * 100)}%`;
}

/** The parts of Electron's `Input` that the alias keys need. */
export interface ZoomInput {
  type: string;
  key: string;
  code: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
}

/**
 * The zoom step for a key the menu cannot own.
 *
 * The menu owns ⌘= / ⌘- / ⌘0. These are the other chords VS Code accepts:
 * ⌘+ (Shift+= on a US keyboard, its own key on many others), ⌘_ and the
 * numeric keypad. A menu accelerator matches one key only, so the main
 * process reads these from the input stream instead.
 */
export function zoomAliasForInput(input: ZoomInput, mac: boolean): ZoomStep | null {
  if (input.type !== 'keyDown' || input.alt) return null;
  const mod = mac ? input.meta && !input.control : input.control && !input.meta;
  if (!mod) return null;
  if (input.code === 'NumpadAdd') return 'in';
  if (input.code === 'NumpadSubtract') return 'out';
  // With Num Lock off this key is Insert, and Ctrl+Insert is Copy.
  if (input.code === 'Numpad0' && input.key === '0') return 'reset';
  if (input.key === '+') return 'in';
  if (input.key === '_') return 'out';
  return null;
}
