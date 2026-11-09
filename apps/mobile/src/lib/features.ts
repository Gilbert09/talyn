import type { Features } from '@talyn/shared';

import { useResource } from '../workflow/hooks';

export type FeatureKey = keyof Features;

/**
 * Whether the account may see a feature, like web. A key the server did not
 * send is not offered, and nothing is offered before the answer arrives.
 */
export function featureOffered(features: Partial<Features> | null | undefined, key: FeatureKey): boolean {
  return features?.[key] === true;
}

/**
 * The allow-listed features from `GET /features`, or null while the first
 * answer loads. The store keeps the last answer through a failed refresh, and
 * it fetches again when the app returns to the foreground or the workspace
 * changes. This only decides what to draw: every server route gates itself.
 */
export function useFeatures(): Features | null {
  const state = useResource<Features>('features');
  return state.data ?? null;
}

export function useFeature(key: FeatureKey): boolean {
  return featureOffered(useFeatures(), key);
}
