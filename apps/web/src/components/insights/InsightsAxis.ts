export function axisStep(max: number): number {
  if (max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max / 3));
  return Math.max(0.1,
    [1, 2, 5, 10]
      .map((part) => part * magnitude)
      .find((step) => step * 3 >= max) ?? 10 * magnitude
  );
}

export function axisTick(value: number, step: number): string {
  if (step < 1) return value.toFixed(1);
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}
