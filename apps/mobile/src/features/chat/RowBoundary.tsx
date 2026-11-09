import { Component, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText, Button } from '../../components/UI';

interface Props { children: ReactNode; label: string; resetKey: unknown; retry?: boolean }
interface State { failed: boolean; key: unknown }

/**
 * Catches a render error in part of the conversation and shows a notice in its place.
 * In a release build an uncaught render error closes the app, so one bad event must not reach the root.
 * A new `resetKey` (new data for the part) tries again.
 */
export class RowBoundary extends Component<Props, State> {
  state: State = { failed: false, key: this.props.resetKey };
  static getDerivedStateFromError(): Partial<State> { return { failed: true }; }
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }
  componentDidCatch(error: unknown) {
    if (__DEV__) console.warn(`${this.props.label} failed to render`, error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <View accessible accessibilityRole="alert" style={styles.notice}>
      <AppText variant="caption" tone="muted" style={styles.text}>{this.props.label} could not be shown.</AppText>
      {this.props.retry ? <Button size="sm" variant="secondary" title="Try again" onPress={() => this.setState({ failed: false })} /> : null}
    </View>;
  }
}

const styles = StyleSheet.create({
  notice: { alignItems: 'center', gap: 8, paddingVertical: 8 },
  text: { textAlign: 'center' },
});
