import { Link, type Href } from 'expo-router';
import type { PropsWithChildren } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ScreenContainer } from './ScreenContainer';

import { useTheme } from '../theme/tokens';
import { Label, ui } from './UI';

export const useShellColors = useTheme;

export function ShellScreen({ title, description, children, topInset = false, centered = false }: PropsWithChildren<{
  title: string; description?: string; topInset?: boolean; centered?: boolean;
}>) {
  const colors = useTheme();
  return <ScreenContainer topInset={topInset}>
    <KeyboardAvoidingView style={styles.safeArea} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.scrollContent, centered && { justifyContent: 'center' }]}>
        <View style={styles.content}>
          <View style={{ gap: 8 }}><Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{title}</Text>
            {description ? <Label muted>{description}</Label> : null}</View>
          {children}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  </ScreenContainer>;
}
export function ShellLink({ href, label }: { href: Href; label: string }) {
  const colors = useTheme();
  return <Link href={href} asChild>
    <Pressable accessibilityRole="link" accessibilityLabel={label}
      style={({ pressed }) => [styles.link, { opacity: pressed ? 0.65 : 1 }]}>
      <Text style={[ui.body, { color: colors.mode === 'light' ? colors.primaryAction : colors.primary, fontWeight: '600', flex: 1 }]}>{label}</Text>
      <Text accessible={false} style={{ color: colors.muted, fontSize: 22 }}>›</Text>
    </Pressable>
  </Link>;
}
export function ShellText({ children }: PropsWithChildren) { return <Label>{children}</Label>; }
const styles = StyleSheet.create({
  safeArea: { flex: 1 }, scrollContent: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 24, paddingBottom: 32 },
  content: { width: '100%', maxWidth: 680, alignSelf: 'center', gap: 24 },
  title: { fontSize: 30, lineHeight: 38, fontWeight: '700', letterSpacing: -0.6 },
  link: { minHeight: 44, paddingVertical: 10, gap: 8, flexDirection: 'row', alignItems: 'center' },
});
