import { useState } from 'react';

import { AppText, Row, Toggle } from '../../components/UI';
import { getAnalyticsOptOut, isAnalyticsConfigured, setAnalyticsOptOut } from '../../lib/analytics';

/** The web Privacy toggle: on means sharing, which is "not opted out". */
export function AnalyticsSetting({ divider = false }: { divider?: boolean }) {
  const configured = isAnalyticsConfigured();
  const [share, setShare] = useState(() => !getAnalyticsOptOut());
  const change = (next: boolean) => {
    setShare(next);
    void setAnalyticsOptOut(!next);
  };
  const title = 'Share usage data and session replays';
  return <Row title={title} divider={divider}
    subtitle={<AppText variant="meta" tone="muted">
      {configured ? 'Helps us improve Talyn by collecting usage events, errors, and session replays of the app. Text and images are masked in replays.'
        : 'Analytics is not enabled in this build. Nothing is collected either way.'}
    </AppText>}
    trailing={<Toggle value={configured && share} disabled={!configured} onValueChange={change}
      accessibilityLabel={title} accessibilityState={{ disabled: !configured, checked: configured && share }} />} />;
}
