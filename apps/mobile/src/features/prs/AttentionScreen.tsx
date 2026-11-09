import { PullRequestsScreen } from './PullRequestsScreen';

/** The old Attention tab. It is now My PRs; `/attention` redirects to `/pulls?tab=mine`. */
export function AttentionScreen() {
  return <PullRequestsScreen tab="mine" />;
}
export default AttentionScreen;
