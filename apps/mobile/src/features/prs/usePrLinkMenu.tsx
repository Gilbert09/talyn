import type { PRRow } from '@talyn/client/native';
import * as Clipboard from 'expo-clipboard';
import { Alert, Share } from 'react-native';

import { useActionSheet, useToast, type SheetAction, type Symbol } from '../../components/UI';
import { openExternal, safeExternalUrl } from '../../components/Workflow';
import { PR_LINK_ACTION_LABEL, prCopyText, prLinkActions, type PrLinkActionKind } from './copyLink';

const ICONS: Record<PrLinkActionKind, Symbol> = {
  copy_link: { ios: 'link', android: 'link' },
  copy_markdown: { ios: 'doc.on.doc', android: 'content_copy' },
  share: { ios: 'square.and.arrow.up', android: 'share' },
  open: { ios: 'safari', android: 'open_in_new' },
};

export type PrLinkTarget = { title: string; url: string; ref: string };

export function prLinkTarget(row: Pick<PRRow, 'number' | 'owner' | 'repo'> & { summary: { title: string; url: string } }): PrLinkTarget | null {
  const url = safeExternalUrl(row.summary.url);
  return url ? { title: row.summary.title, url, ref: `${row.owner}/${row.repo} #${row.number}` } : null;
}

/** Copy, share and open for a PR. `actions` gives the same items for a bigger menu. Render `sheet` and `toast` last inside the screen. */
export function usePrLinkMenu() {
  const sheet = useActionSheet();
  const toast = useToast();
  const copy = (kind: 'copy_link' | 'copy_markdown', target: PrLinkTarget) => {
    const { text, done } = prCopyText(kind, target.title, target.url);
    Clipboard.setStringAsync(text).then(() => toast.show(done), () => Alert.alert('Could not copy', 'Please try again.'));
  };
  const run = (kind: PrLinkActionKind, target: PrLinkTarget) => {
    if (kind === 'copy_link' || kind === 'copy_markdown') copy(kind, target);
    else if (kind === 'share') void Share.share({ message: target.url, url: target.url }).catch(() => {});
    else openExternal(target.url);
  };
  const actions = (target: PrLinkTarget | null): SheetAction[] => target ? prLinkActions(target.url).map((kind) => ({
    label: PR_LINK_ACTION_LABEL[kind], icon: ICONS[kind], onPress: () => run(kind, target),
  })) : [];
  const open = (target: PrLinkTarget | null) => {
    if (!target) return;
    sheet.open({ title: target.title || 'Pull request', message: target.ref, actions: actions(target) });
  };
  return { open, actions, copyLink: (target: PrLinkTarget | null) => { if (target) copy('copy_link', target); }, sheet: sheet.sheet, toast: toast.element };
}
