/**
 * The workbench body's layout that outlives a restart: the right panel's
 * width and tab, and the terminal dock's height. Per device, so it lives in
 * localStorage rather than on the workbench. Every read is defensive — a
 * value from an older build, or a hand-edited one, falls back to the default
 * instead of drawing a 0px panel.
 */

export type GitPanelTab = 'files' | 'changes' | 'pr';

export const GIT_PANEL_TABS: readonly GitPanelTab[] = ['files', 'changes', 'pr'];

export const GIT_PANEL_MIN_WIDTH = 280;
export const GIT_PANEL_MAX_WIDTH = 720;
export const GIT_PANEL_DEFAULT_WIDTH = 340;

export const DOCK_MIN_HEIGHT = 120;
export const DOCK_DEFAULT_HEIGHT = 260;
/** The panel above the dock keeps at least this much, so its tabs stay usable. */
export const DOCK_RESERVED_ABOVE = 160;

export const LAYOUT_STORAGE_KEY = 'talyn.workbench.layout';

export interface WorkbenchLayout {
  gitPanelTab: GitPanelTab;
  gitPanelWidth: number;
  dockHeight: number;
}

export const DEFAULT_LAYOUT: WorkbenchLayout = {
  gitPanelTab: 'changes',
  gitPanelWidth: GIT_PANEL_DEFAULT_WIDTH,
  dockHeight: DOCK_DEFAULT_HEIGHT,
};

/** The stored tab, with the old Checks tab read as the Pull request tab that replaced it. */
function storedTab(value: unknown): GitPanelTab {
  if (value === 'checks') return 'pr';
  return GIT_PANEL_TABS.includes(value as GitPanelTab) ? (value as GitPanelTab) : DEFAULT_LAYOUT.gitPanelTab;
}

export function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return GIT_PANEL_DEFAULT_WIDTH;
  return Math.min(GIT_PANEL_MAX_WIDTH, Math.max(GIT_PANEL_MIN_WIDTH, Math.round(width)));
}

/** `available` is the height of the column the dock sits in; without one only the minimum applies. */
export function clampDockHeight(height: number, available?: number): number {
  if (!Number.isFinite(height)) return DOCK_DEFAULT_HEIGHT;
  const max = available && available > 0 ? Math.max(DOCK_MIN_HEIGHT, available - DOCK_RESERVED_ABOVE) : Infinity;
  return Math.min(max, Math.max(DOCK_MIN_HEIGHT, Math.round(height)));
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readLayout(): WorkbenchLayout {
  try {
    const raw = storage()?.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    const parsed = JSON.parse(raw) as Partial<Record<keyof WorkbenchLayout, unknown>>;
    return {
      gitPanelTab: storedTab(parsed.gitPanelTab),
      gitPanelWidth:
        typeof parsed.gitPanelWidth === 'number' ? clampPanelWidth(parsed.gitPanelWidth) : DEFAULT_LAYOUT.gitPanelWidth,
      dockHeight: typeof parsed.dockHeight === 'number' ? clampDockHeight(parsed.dockHeight) : DEFAULT_LAYOUT.dockHeight,
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function writeLayout(patch: Partial<WorkbenchLayout>): void {
  try {
    const s = storage();
    if (!s) return;
    s.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ ...readLayout(), ...patch }));
  } catch {
    // Storage full or blocked: the layout simply does not survive a restart.
  }
}
