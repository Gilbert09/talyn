import { fireEvent, render, screen } from '@testing-library/react-native';

import { AnalyticsSetting } from '../features/settings/AnalyticsSetting';

let mockConfigured = true;
let mockOptedOut = false;
const mockSetOptOut = jest.fn(async (_value: boolean) => {});
jest.mock('../lib/analytics', () => ({
  isAnalyticsConfigured: () => mockConfigured,
  getAnalyticsOptOut: () => mockOptedOut,
  setAnalyticsOptOut: (value: boolean) => mockSetOptOut(value),
}));

const NAME = 'Share usage data and session replays';

beforeEach(() => {
  mockConfigured = true;
  mockOptedOut = false;
  mockSetOptOut.mockClear();
});

describe('AnalyticsSetting', () => {
  it.each([
    [false, true],
    [true, false],
  ])('with the saved opt-out %s, the switch reads %s', async (optedOut, checked) => {
    mockOptedOut = optedOut;
    await render(<AnalyticsSetting />);
    expect(screen.getByLabelText(NAME).props.value).toBe(checked);
  });

  it.each([
    [false, true],
    [true, false],
  ])('turning the switch to %s saves the opt-out %s', async (next, optOut) => {
    mockOptedOut = next;
    await render(<AnalyticsSetting />);
    await fireEvent(screen.getByLabelText(NAME), 'valueChange', next);
    expect(mockSetOptOut).toHaveBeenCalledWith(optOut);
    expect(screen.getByLabelText(NAME).props.value).toBe(next);
  });

  it('is off and disabled when the build has no key', async () => {
    mockConfigured = false;
    await render(<AnalyticsSetting />);
    const toggle = screen.getByLabelText(NAME);
    expect(toggle.props.value).toBe(false);
    expect(toggle.props.disabled).toBe(true);
    expect(screen.getByText('Analytics is not enabled in this build. Nothing is collected either way.')).toBeVisible();
  });

  it('explains what is collected', async () => {
    await render(<AnalyticsSetting />);
    expect(screen.getByText(/usage events, errors, and session replays/)).toBeVisible();
  });
});
