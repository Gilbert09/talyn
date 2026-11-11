import {
  startProgressFraction,
  WORKBENCH_START_STEP_LABELS,
  type Workbench,
  type WorkbenchStartProgress,
  type WorkbenchStartStep,
} from '@talyn/shared';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { sans, type, useTheme, withAlpha } from '../../theme/tokens';

/** Still being set up, and not failed. An error wins, as on web and desktop. */
export function isStarting(workbench: Pick<Workbench, 'status' | 'sandboxState'>): boolean {
  if (workbench.status === 'error' || workbench.sandboxState === 'error') return false;
  return workbench.status === 'provisioning' || workbench.sandboxState === 'creating' || workbench.sandboxState === 'lost';
}

/** How often the estimate moves while git says nothing. */
export const START_PROGRESS_TICK_MS = 400;

/** The order of a session's start steps. A thread has only the first. */
const STEPS: readonly WorkbenchStartStep[] = ['sandbox', 'code', 'setup'];
const BAR_WIDTH = 240;

/**
 * The bar's fill, 0..1, or null for an indeterminate bar. It never moves
 * backwards within a step: a broadcast from another server carries no git
 * percentage, and the estimate must not undo what git already said.
 */
export function useStartFraction(progress: WorkbenchStartProgress | null | undefined): number | null {
  const [, setTick] = useState(0);
  const held = useRef<{ key: string; value: number } | null>(null);
  const estimating = Boolean(progress && progress.percent === null && progress.expectedMs);
  useEffect(() => {
    if (!estimating) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), START_PROGRESS_TICK_MS);
    return () => clearInterval(timer);
  }, [estimating]);
  if (!progress) return null;
  const key = `${progress.step}:${progress.stepStartedAt}`;
  const prior = held.current?.key === key ? held.current.value : null;
  const computed = startProgressFraction(progress, Date.now());
  if (computed === null) return prior;
  const value = prior === null ? computed : Math.max(prior, computed);
  held.current = { key, value };
  return value;
}

/** The step line, e.g. "Step 2 of 3 · Getting the code". */
export function startStepText(progress: WorkbenchStartProgress): string {
  const name = WORKBENCH_START_STEP_LABELS[progress.step];
  return progress.stepCount > 1 ? `Step ${progress.stepIndex + 1} of ${progress.stepCount} · ${name}` : name;
}

/** Git's own progress through the clone, or null. */
export function startGitText(progress: WorkbenchStartProgress): string | null {
  return progress.percent !== null ? `${progress.detail ?? 'Getting the code'} · ${Math.round(progress.percent)}%` : null;
}

export function startQueueText(queued: number): string {
  const ready = 'the sandbox is ready';
  if (queued === 0) return `You can write your first message now. It is sent when ${ready}.`;
  if (queued === 1) return `Your message is queued. It is sent when ${ready}.`;
  return `${queued} messages are queued. They are sent in order when ${ready}.`;
}

function startTitle(workbench: Pick<Workbench, 'sandboxState'>): string {
  return workbench.sandboxState === 'lost' ? 'Starting a new sandbox' : 'Starting the sandbox';
}

function useReduceMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (active) setReduced(value); }, () => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { active = false; subscription.remove(); };
  }, []);
  return reduced;
}

/** A determinate fill, or a sweep while there is no basis for a number. */
function StartBar({ fraction, label, width = BAR_WIDTH }: { fraction: number | null; label: string; width?: number }) {
  const c = useTheme();
  const reduced = useReduceMotion();
  const sweep = useRef(new Animated.Value(0)).current;
  const indeterminate = fraction === null;
  useEffect(() => {
    if (!indeterminate || reduced) { sweep.setValue(0.5); return undefined; }
    sweep.setValue(0);
    const loop = Animated.loop(Animated.timing(sweep, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.ease), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [indeterminate, reduced, sweep]);
  const segment = width * 0.35;
  return <View accessible accessibilityRole="progressbar" accessibilityLabel={label}
    accessibilityValue={fraction === null ? undefined : { min: 0, max: 100, now: Math.round(fraction * 100) }}
    style={[local.track, { width, maxWidth: '100%', backgroundColor: c.surface }]}>
    {indeterminate
      ? <Animated.View testID="start-progress-sweep" style={[local.fill, { width: segment, backgroundColor: c.primaryAction,
        transform: [{ translateX: sweep.interpolate({ inputRange: [0, 1], outputRange: [-segment, width] }) }] }]} />
      : <View testID="start-progress-fill" style={[local.fill, { width: `${Math.round(fraction * 100)}%`, backgroundColor: c.primaryAction }]} />}
  </View>;
}

type StepState = 'done' | 'current' | 'next';

function StepRow({ label, state }: { label: string; state: StepState }) {
  const c = useTheme();
  const color = state === 'next' ? c.muted : c.text;
  return <View accessible accessibilityLabel={`${label}, ${state === 'done' ? 'done' : state === 'current' ? 'in progress' : 'not started'}`} style={local.step}>
    <View style={local.stepIcon}>
      {state === 'done' ? <SymbolView name={{ ios: 'checkmark.circle.fill', android: 'check_circle' }} size={16} tintColor={c.success} />
        : state === 'current' ? <ActivityIndicator size="small" color={c.primaryAction} style={local.stepSpinner} />
          : <View style={[local.stepDot, { borderColor: withAlpha(c.muted, 0.6) }]} />}
    </View>
    <Text style={[type.meta, state === 'current' ? sans(600) : null, { color, flexShrink: 1 }]}>{label}</Text>
  </View>;
}

/**
 * The empty conversation while the sandbox starts: what it does now, the
 * steps that are left, and what happens to a message written meanwhile.
 * Mirrors web and desktop `StartingHint`.
 */
export function StartingHint({ workbench, queued, canWrite = true }: { workbench: Workbench; queued: number; canWrite?: boolean }) {
  const c = useTheme();
  const progress = workbench.startProgress ?? null;
  const fraction = useStartFraction(progress);
  const title = startTitle(workbench);
  const stepText = progress ? startStepText(progress) : null;
  const git = progress ? startGitText(progress) : null;
  const steps = progress && progress.stepCount > 1 ? STEPS.slice(0, progress.stepCount) : [];
  const status = workbench.statusMessage?.trim();
  return <View testID="workbench-starting" accessibilityLiveRegion="polite" style={local.hint}>
    <View style={[local.badge, { backgroundColor: withAlpha(c.primary, c.mode === 'dark' ? 0.18 : 0.1) }]}>
      <SymbolView name={{ ios: 'shippingbox', android: 'deployed_code' }} size={26} tintColor={c.primary} />
    </View>
    <Text accessibilityRole="header" style={[type.rowTitle, { color: c.text, textAlign: 'center' }]}>{title}</Text>
    <StartBar fraction={fraction} label={[stepText ?? title, git].filter(Boolean).join('. ')} />
    {steps.length ? <View style={local.steps}>
      {steps.map((step, index) => <StepRow key={step} label={WORKBENCH_START_STEP_LABELS[step]}
        state={index < progress!.stepIndex ? 'done' : index === progress!.stepIndex ? 'current' : 'next'} />)}
    </View> : stepText && stepText !== title ? <Text style={[type.meta, sans(600), { color: c.text, textAlign: 'center' }]}>{stepText}</Text> : null}
    {git ? <Text style={[type.caption, { color: c.muted, textAlign: 'center', fontVariant: ['tabular-nums'] }]}>{git}</Text> : null}
    {status ? <Text style={[type.caption, { color: c.muted, textAlign: 'center' }]}>{status}</Text> : null}
    {canWrite ? <Text style={[type.caption, { color: c.muted, textAlign: 'center' }]}>{startQueueText(queued)}</Text> : null}
  </View>;
}

/** One line under queued messages while the sandbox starts. */
export function StartingLine({ workbench }: { workbench: Workbench }) {
  const c = useTheme();
  const progress = workbench.startProgress ?? null;
  const fraction = useStartFraction(progress);
  const title = startTitle(workbench);
  const stepText = progress ? startStepText(progress) : null;
  const text = stepText && stepText !== title ? `${title} · ${stepText}` : title;
  return <View testID="workbench-starting-line" accessibilityLiveRegion="polite" style={local.line}>
    <View style={local.lineText}>
      <ActivityIndicator size="small" color={c.muted} />
      <Text style={[type.caption, { color: c.muted, flexShrink: 1 }]}>{text}</Text>
    </View>
    <StartBar fraction={fraction} label={text} width={160} />
  </View>;
}

const local = StyleSheet.create({
  hint: { alignItems: 'center', gap: 10, paddingHorizontal: 24, paddingVertical: 32, alignSelf: 'center', maxWidth: 360, width: '100%' },
  badge: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden', marginVertical: 4 },
  fill: { height: 4, borderRadius: 2 },
  steps: { alignSelf: 'stretch', gap: 8, paddingHorizontal: 24, paddingVertical: 4 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepIcon: { width: 18, height: 18, alignItems: 'center', justifyContent: 'center' },
  stepSpinner: { transform: [{ scale: 0.75 }] },
  stepDot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5 },
  line: { gap: 6, paddingVertical: 6 },
  lineText: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
