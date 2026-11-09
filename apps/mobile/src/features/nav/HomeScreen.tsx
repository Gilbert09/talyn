import { StyleSheet, Text } from 'react-native';

import { useWorkspaceName } from '../../components/ScreenHeader';
import { featureOffered, useFeatures } from '../../lib/features';
import { sans, useTheme } from '../../theme/tokens';
import { NewWorkScreen } from '../create/NewWorkScreen';
import { PullRequestsScreen } from '../prs/PullRequestsScreen';

/**
 * Home, like web's landing page: the new-session composer. An account
 * without sessions gets its pull request lists instead.
 */
export function HomeScreen() {
  const features = useFeatures();
  if (features !== null && !featureOffered(features, 'workbenches')) return <PullRequestsScreen tab="mine" />;
  return <NewWorkScreen presentation="home" />;
}

/** The home header's title: the workspace name. */
export function HomeTitle() {
  const c = useTheme();
  const name = useWorkspaceName();
  return <Text accessibilityRole="header" numberOfLines={1} style={[styles.title, { color: c.text }]}>{name ?? 'Talyn'}</Text>;
}

const styles = StyleSheet.create({
  title: { fontSize: 16, lineHeight: 22, ...sans(600) },
});
