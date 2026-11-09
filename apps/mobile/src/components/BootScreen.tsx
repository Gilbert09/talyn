import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { OWL_BOOT_LINES, owlArt, useOwlBlink } from '../lib/owl';
import { fonts, useTheme, withAlpha } from '../theme/tokens';

const BAR_WIDTH = 176;
const SEGMENT_WIDTH = BAR_WIDTH / 3;
const SCAN_START = -1.6 * SEGMENT_WIDTH;
const SCAN_END = 3.6 * SEGMENT_WIDTH;
const SCAN_CENTRE = (BAR_WIDTH - SEGMENT_WIDTH) / 2;

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { alignItems: 'center' },
  owl: { fontFamily: fonts.mono[400], fontSize: 15, lineHeight: 16.5, textAlign: 'left',
    textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 14 },
  scanTrack: { width: BAR_WIDTH, height: 1, borderRadius: 999, overflow: 'hidden', marginTop: 16 },
  scanSegment: { width: SEGMENT_WIDTH, height: 1 },
  log: { flexDirection: 'row', marginTop: 12 },
  logText: { fontFamily: fonts.mono[400], fontSize: 12 },
});

/** The ASCII owl mascot, blinking. Used on the boot and sign-in screens, as on web. */
export function BlinkingOwl({ still = false }: { still?: boolean }) {
  const colors = useTheme();
  const blinking = useOwlBlink(!still);
  return <Text accessible={false} style={[styles.owl, {
    color: colors.primary,
    textShadowColor: withAlpha(colors.primary, 0.35),
  }]}>{owlArt(blinking ? '-   -' : 'O   O')}</Text>;
}

export function BootScreen({ label }: { label?: string }) {
  const colors = useTheme();
  const [reduceMotion, setReduceMotion] = useState(false);
  const [line, setLine] = useState(0);
  const [dots, setDots] = useState(0);
  const [caretVisible, setCaretVisible] = useState(true);
  const scanX = useRef(new Animated.Value(SCAN_START)).current;

  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (reduceMotion) {
      setLine(0);
      setDots(0);
      setCaretVisible(true);
      scanX.setValue(SCAN_CENTRE);
      return;
    }

    scanX.setValue(SCAN_START);
    const sweep = Animated.loop(Animated.timing(scanX, {
      toValue: SCAN_END,
      duration: 1600,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    }));
    sweep.start();
    const lineId = setInterval(() => setLine((current) => (current + 1) % OWL_BOOT_LINES.length), 1600);
    const dotId = setInterval(() => setDots((current) => (current + 1) % 4), 420);
    const caretId = setInterval(() => setCaretVisible((current) => !current), 500);

    return () => {
      sweep.stop();
      clearInterval(lineId);
      clearInterval(dotId);
      clearInterval(caretId);
    };
  }, [reduceMotion, scanX]);

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}
      accessible accessibilityRole="progressbar" accessibilityLabel={label ?? 'Starting Talyn'}>
      <View style={styles.content} accessible={false}>
        <BlinkingOwl still={reduceMotion} />
        <View accessible={false} style={[styles.scanTrack, { backgroundColor: withAlpha(colors.border, 0.6) }]}>
          <Animated.View style={[styles.scanSegment, {
            experimental_backgroundImage: `linear-gradient(to right, transparent, ${colors.primary}, transparent)`,
            transform: [{ translateX: scanX }],
          }]} />
        </View>
        <View style={styles.log} accessible={false}>
          <Text accessible={false} style={[styles.logText, { color: colors.primary }]}>{'> '}</Text>
          <Text accessible={false} style={[styles.logText, { color: colors.muted }]}>{OWL_BOOT_LINES[line]}</Text>
          <Text accessible={false} style={[styles.logText, { color: colors.primary }]}>{'.'.repeat(dots)}</Text>
          <Text accessible={false} style={[styles.logText, { color: colors.primary, opacity: caretVisible ? 1 : 0 }]}>{'▋'}</Text>
        </View>
      </View>
    </View>
  );
}
