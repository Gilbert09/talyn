import { releaseNotes } from '@talyn/client/native';
import type { ReleaseNoteEntry } from '@talyn/shared';

import { useNetwork } from '../../auth/AuthProvider';
import { AppText, EmptyState, Group, Pill, Row } from '../../components/UI';
import { StateNotice } from '../../components/Workflow';
import { Intro, Page } from '../more/Page';
import { useRemote } from '../more/useRemote';
import { KIND_LABEL, KIND_TONE, WHATS_NEW_EMPTY, WHATS_NEW_INTRO, mobileReleaseNotes, releaseDateLabel } from './model';

/** Settings → About → What's new. Shows only the highlights for the mobile app. */
export function WhatsNewScreen() {
  const offline = useNetwork() === 'offline';
  const notes = useRemote<ReleaseNoteEntry[]>('release-notes', () => releaseNotes.list());
  const releases = mobileReleaseNotes(notes.data);
  return <Page refreshing={notes.refreshing} onRefresh={() => { void notes.refresh(); }}>
    <Intro>{WHATS_NEW_INTRO}</Intro>
    <StateNotice resource={notes} offline={offline} refresh={() => { void notes.refresh(); }} />
    {notes.data !== undefined && releases.length === 0 ? <EmptyState title="Nothing new yet" detail={WHATS_NEW_EMPTY} /> : null}
    {releases.map((entry) => <Group key={entry.version} title={releaseDateLabel(entry.publishedAt)}>
      {entry.highlights.map((h, index) => <Row key={`${entry.version}-${h.title}`} title={h.title} titleLines={3}
        divider={index < entry.highlights.length - 1}
        trailing={<Pill label={KIND_LABEL[h.kind]} tone={KIND_TONE[h.kind]} />}
        accessibilityLabel={`${KIND_LABEL[h.kind]}: ${h.title}. ${h.description}`}
        subtitle={<AppText variant="meta" tone="muted">{h.description}</AppText>} />)}
    </Group>)}
  </Page>;
}
