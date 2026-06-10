import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * True when running in the Electron desktop app on macOS, where the window
 * is frameless (hidden title bar + inset traffic lights) and the UI must
 * reserve a drag strip at the top.
 */
export const isMacDesktop =
  typeof window !== 'undefined' && window.electron?.platform === 'darwin';
