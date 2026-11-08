import { Link, type Href } from 'expo-router';
import type { PropsWithChildren } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const palettes = {
  light: { background: '#f5f6f8', card: '#ffffff', text: '#162033', muted: '#48566b', accent: '#244cbd' },
  dark: { background: '#10151f', card: '#1d2635', text: '#f2f5fb', muted: '#bdc9dc', accent: '#a9c2ff' },
};

export function useShellColors() {
  return palettes[useColorScheme() === 'dark' ? 'dark' : 'light'];
}

export function ShellScreen({ title, description, children }: PropsWithChildren<{
  title: string;
  description: string;
}>) {
  const colors = useShellColors();
  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.content}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{title}</Text>
          <Text style={[styles.description, { color: colors.muted }]}>{description}</Text>
          {children}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export function ShellLink({ href, label }: { href: Href; label: string }) {
  const colors = useShellColors();
  return (
    <Link href={href} asChild>
      <Pressable accessibilityRole="link" accessibilityLabel={label}
        style={({ pressed }) => [styles.link, { backgroundColor: colors.card, opacity: pressed ? 0.7 : 1 }]}>
        <Text style={[styles.linkLabel, { color: colors.accent }]}>{label}</Text>
      </Pressable>
    </Link>
  );
}

export function ShellText({ children }: PropsWithChildren) {
  const colors = useShellColors();
  return <Text style={[styles.description, { color: colors.text }]}>{children}</Text>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  scrollContent: { flexGrow: 1, padding: 24 },
  content: { width: '100%', maxWidth: 680, alignSelf: 'center', gap: 20 },
  title: { fontSize: 32, fontWeight: '700' },
  description: { fontSize: 17, lineHeight: 26 },
  note: { fontSize: 15, lineHeight: 23, marginTop: 12 },
  link: { minHeight: 48, padding: 18, borderRadius: 12, justifyContent: 'center' },
  linkLabel: { fontSize: 17, fontWeight: '600' },
});
