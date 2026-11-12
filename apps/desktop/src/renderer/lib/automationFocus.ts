import { create } from 'zustand';
import { integrationRulesOffered, slackRulesOffered, type Features, type IntegrationKind } from '@talyn/shared';
import { useNavigationStore } from '../stores/navigation';

/** Whether an integration page draws its Automations section. */
export function automationsShown(features: Features | null, kind: IntegrationKind): boolean {
  return kind === 'slack'
    ? features?.workbenches === true && slackRulesOffered(features)
    : integrationRulesOffered(features, kind);
}

/** An automation to open: a rule on an integration page, or a scheduled loop. */
export interface AutomationTarget {
  type: 'workflow' | 'loop';
  id: string;
  /** The integration page the automation lives on. */
  kind: IntegrationKind;
}

interface AutomationFocusState {
  target: AutomationTarget | null;
  clear: () => void;
}

/**
 * Hands one automation from the command palette to its integration page. The
 * route has no automation id, so the page reads the target, opens that
 * automation's editor when its list has loaded, and clears the target.
 */
export const useAutomationFocus = create<AutomationFocusState>((set) => ({
  target: null,
  clear: () => set({ target: null }),
}));

export function openAutomation(target: AutomationTarget): void {
  useAutomationFocus.setState({ target });
  useNavigationStore.getState().navigate({ view: 'integrations', kind: target.kind });
}

/**
 * Consume the target when it names an automation in `rows`. A loaded list that
 * does not hold it (deleted since the palette read it) clears it too, so a
 * later visit does not open it.
 */
export function takeAutomationTarget<T extends { id: string }>(
  type: AutomationTarget['type'],
  kind: IntegrationKind,
  rows: T[] | null
): T | undefined {
  const target = useAutomationFocus.getState().target;
  if (!rows || !target || target.type !== type || target.kind !== kind) return undefined;
  useAutomationFocus.getState().clear();
  return rows.find((row) => row.id === target.id);
}
