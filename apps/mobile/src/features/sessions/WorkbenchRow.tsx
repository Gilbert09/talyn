import type { Workbench } from '@talyn/shared';
import { View } from 'react-native';

import { PrPill, SessionStateIcon } from '../../components/Status';
import { AppText, Row } from '../../components/UI';
import { workbenchState } from '../../lib/status';
import { relativeTimeLabel, shortTime } from '../../lib/time';
import { sessionRoute, threadRoute } from '../../navigation/routes';
import { workbenchKind, workbenchTitle } from '../../workflow/model';

/** One session or thread: state mark, title, PR number, and when it last changed. */
export function WorkbenchRow({ item, now, divider = true }: { item: Workbench; now: number; divider?: boolean }) {
  const state = workbenchState(item);
  const title = workbenchTitle(item);
  const updated = relativeTimeLabel(item.updatedAt, now);
  return <Row href={workbenchKind(item) === 'thread' ? threadRoute(item.id) : sessionRoute(item.id)} title={title} divider={divider}
    accessibilityLabel={[`${title}.`, `${state.label}.`, item.pr ? `Pull request ${item.pr.number}.` : '', updated ? `Updated ${updated}.` : '']
      .filter(Boolean).join(' ')}
    leading={<SessionStateIcon state={state} />}
    trailing={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      {item.pr ? <PrPill number={item.pr.number} state={item.pr.state} /> : null}
      <AppText variant="meta" tone="muted">{shortTime(item.updatedAt, now)}</AppText>
    </View>} />;
}
