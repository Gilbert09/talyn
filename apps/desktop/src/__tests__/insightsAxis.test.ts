import { axisStep, axisTick } from '../renderer/components/insights/InsightsAxis';

describe('insight axis', () => {
  it.each([[0, 50, '0'], [50, 50, '50'], [150, 50, '150'], [0.5, 0.5, '0.5'], [1500, 500, '1,500']] as const)('formats %s with step %s as %s', (value, step, expected) => {
    expect(axisTick(value, step)).toBe(expected);
  });

  it('uses whole steps for whole values', () => {
    expect(axisStep(150)).toBe(50);
    expect(axisStep(7.5)).toBe(5);
    expect(axisStep(0.001)).toBe(0.1);
  });
});
