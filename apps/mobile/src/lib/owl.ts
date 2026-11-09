import { useEffect, useState } from 'react';

export const OWL_BOOT_LINES = [
  'waking the owl',
  'ruffling feathers',
  'scanning the perch',
  'syncing pull requests',
  'sharpening talons',
  'engaging night vision',
];

export function owlArt(eyes: string): string {
  return [
    '  .-"""-.',
    ` ( ${eyes} )`,
    ' (   v   )',
    "  ) '-' (",
    ' (_/   \\_)',
  ].join('\n');
}

export function useOwlBlink(enabled = true): boolean {
  const [blinking, setBlinking] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setBlinking(false);
      return;
    }

    const timers: ReturnType<typeof setTimeout>[] = [];
    let alive = true;
    const wink = (then: () => void) => {
      setBlinking(true);
      timers.push(setTimeout(() => {
        setBlinking(false);
        timers.push(setTimeout(then, 110));
      }, 130));
    };
    const loop = () => {
      if (!alive) return;
      const hold = 1700 + Math.floor(Math.random() * 2200);
      timers.push(setTimeout(() => {
        if (Math.random() < 0.35) wink(() => wink(loop));
        else wink(loop);
      }, hold));
    };
    loop();

    return () => {
      alive = false;
      timers.forEach(clearTimeout);
    };
  }, [enabled]);

  return blinking;
}
