import { SymbolView } from 'expo-symbols';
import type { PropsWithChildren, ReactNode } from 'react';
import { Fragment, useEffect } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BlinkingOwl } from '../../components/BootScreen';
import { ScreenContainer } from '../../components/ScreenContainer';
import { AppText } from '../../components/UI';
import { trackEvent } from '../../lib/analytics';
import { ONBOARDING_STEPS, stepIndex, type OnboardingStep } from '../../navigation/onboardingGate';
import { fonts, sans, useTheme } from '../../theme/tokens';

export const STEP_TITLES: Record<OnboardingStep, string> = {
  github: 'Connect GitHub',
  repos: 'Choose where your agent will work.',
  agent: 'Connect your agent',
};

/** Numbered dots: done steps are green with a check, the current one is outlined in the accent. */
export function ProgressDots({ step }: { step: OnboardingStep }) {
  const c = useTheme();
  const current = stepIndex(step);
  return <View accessible accessibilityRole="progressbar" accessibilityLabel={`Step ${current + 1} of ${ONBOARDING_STEPS.length}`}
    accessibilityValue={{ min: 1, max: ONBOARDING_STEPS.length, now: current + 1 }} style={styles.dots}>
    {ONBOARDING_STEPS.map((key, index) => {
      const done = index < current;
      const active = index === current;
      return <Fragment key={key}>
        <View testID={`onboarding-dot-${key}`} style={[styles.dot, {
          borderColor: done ? c.success : active ? c.primaryAction : c.border,
          backgroundColor: done ? c.success : 'transparent',
        }]}>
          {done ? <SymbolView name={{ ios: 'checkmark', android: 'check' }} size={12} tintColor={c.background} />
            : <Text style={[styles.dotText, { color: active ? c.primaryAction : c.muted }]}>{index + 1}</Text>}
        </View>
        {index < ONBOARDING_STEPS.length - 1 ? <View style={[styles.line, { backgroundColor: done ? c.success : c.border }]} /> : null}
      </Fragment>;
    })}
  </View>;
}

/**
 * One full-screen onboarding step with no navigation header: the owl and
 * heading of the sign-in screen, the progress dots, the step, and a footer.
 */
export function OnboardingShell({ step, footer, children }: PropsWithChildren<{ step: OnboardingStep; footer?: ReactNode }>) {
  const c = useTheme();
  useEffect(() => { trackEvent('onboarding_step_viewed', { step }); }, [step]);
  return <ScreenContainer topInset>
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>
        <View style={styles.page}>
          <View style={styles.hero}>
            <BlinkingOwl />
            <Text accessibilityRole="header" style={[styles.title, { color: c.text }]}>Welcome to Talyn</Text>
            <AppText variant="meta" tone="muted" style={styles.center}>Let&apos;s get your workspace set up.</AppText>
          </View>
          <ProgressDots step={step} />
          <View style={styles.body}>
            <AppText accessibilityRole="header" variant="heading">{STEP_TITLES[step]}</AppText>
            {children}
          </View>
        </View>
      </ScrollView>
      {footer ? <View style={[styles.footer, { borderTopColor: c.border, backgroundColor: c.background }]}>{footer}</View> : null}
    </KeyboardAvoidingView>
  </ScreenContainer>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scroll: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 24, paddingBottom: 24 },
  page: { width: '100%', maxWidth: 520, alignSelf: 'center', gap: 20 },
  hero: { alignItems: 'center', gap: 6 },
  title: { fontFamily: fonts.display[600], fontSize: 24, lineHeight: 30, letterSpacing: -0.3, marginTop: 8 },
  center: { textAlign: 'center' },
  dots: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  dot: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  dotText: { fontSize: 12, lineHeight: 16, ...sans(500) },
  line: { width: 24, height: StyleSheet.hairlineWidth * 2 },
  body: { gap: 14 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 20,
    paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth },
});
