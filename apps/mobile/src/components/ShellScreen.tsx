import { Link, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import type { PropsWithChildren } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ScreenContainer } from './ScreenContainer';

import { sans, type, useTheme } from '../theme/tokens';
import { Label } from './UI';

export const useShellColors = useTheme;

export function ShellScreen({ title, description, children, topInset = false, centered = false }: PropsWithChildren<{
  title: string; description?: string; topInset?: boolean; centered?: boolean;
}>) {
  const colors = useTheme();
  return <ScreenContainer topInset={topInset}>
    <KeyboardAvoidingView style={styles.safeArea} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.scrollContent, centered && { justifyContent: 'center' }]}>
        <View style={styles.content}>
          <View style={{ gap: 6 }}><Text accessibilityRole="header" style={[type.title, { color: colors.text }]}>{title}</Text>
            {description ? <Label muted>{description}</Label> : null}</View>
          {children}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  </ScreenContainer>;
}
/**
 * A text link with a trailing chevron. The style is static and the row is an
 * inner View: a style function on a Pressable under `Link asChild` is dropped.
 */
export function ShellLink({ href, label }: { href: Href; label: string }) {
  const colors = useTheme();
  return <Link href={href} asChild>
    <Pressable accessibilityRole="link" accessibilityLabel={label} style={styles.link}>
      <View style={styles.linkRow}>
        <Text style={[type.body, sans(600), { color: colors.primaryAction, flexShrink: 1 }]}>{label}</Text>
        <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right' }} size={14} tintColor={colors.primaryAction} />
      </View>
    </Pressable>
  </Link>;
}
export function ShellText({ children }: PropsWithChildren) { return <Label>{children}</Label>; }
const styles = StyleSheet.create({
  safeArea: { flex: 1 }, scrollContent: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 },
  content: { width: '100%', maxWidth: 680, alignSelf: 'center', gap: 20 },
  link: { minHeight: 44, justifyContent: 'center' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
