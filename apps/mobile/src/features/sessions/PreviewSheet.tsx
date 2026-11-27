import { ApiError } from '@talyn/client/native';
import type { PreviewPort, Workbench } from '@talyn/shared';
import { useEffect, useRef, useState } from 'react';
import { Linking, ScrollView } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { Banner, Row, SheetModal, Spinner } from '../../components/UI';
import { safeExternalUrl, workflowStyles } from '../../components/Workflow';
import { showActionError } from '../../lib/errors';

const PROBE_INTERVAL_MS = 1500;
const STOPPED_GRACE_MS = 10_000;
const START_TIMEOUT_MS = 10 * 60_000;

export function PreviewSheet({ item, ports, onClose }: { item: Workbench; ports: PreviewPort[]; onClose(): void }) {
  const { workflow } = useMobileRuntime();
  const api = workflow.api.workbenches;
  const offline = useNetwork() === 'offline';
  const active = useRef<AbortController | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const close = () => {
    active.current?.abort();
    onClose();
  };

  const open = async (port: number) => {
    if (active.current || offline) return;
    const attempt = new AbortController();
    active.current = attempt;
    setOpening(port);
    try {
      const { id } = item;
      let status = await api.previewStatus(id, port);
      if (attempt.signal.aborted) return;
      if (!status.ready && !status.running) {
        try {
          await api.runScript(id, 'run');
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'script_running') throw error;
        }
      }
      const deadline = Date.now() + START_TIMEOUT_MS;
      let stoppedSince: number | undefined;
      while (!status.ready && !attempt.signal.aborted) {
        status = await api.previewStatus(id, port, { live: true });
        if (status.ready || attempt.signal.aborted) break;
        const now = Date.now();
        stoppedSince = status.running ? undefined : stoppedSince ?? now;
        if (stoppedSince !== undefined && now - stoppedSince >= STOPPED_GRACE_MS) {
          throw new Error('The run script stopped before the app answered.');
        }
        if (now >= deadline) throw new Error(`The app did not answer on port ${port} within 10 minutes.`);
        await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
      }
      if (attempt.signal.aborted) return;

      const link = await api.previewLink(id, port);
      if (attempt.signal.aborted) return;
      const url = safeExternalUrl(link.url);
      if (!url) throw new Error('Talyn returned an invalid preview link.');
      await Linking.openURL(url).catch(() => { throw new Error('The browser could not open the preview link.'); });
      if (!attempt.signal.aborted) onClose();
    } catch (error) {
      if (!attempt.signal.aborted) showActionError('Could not open the preview', error);
    } finally {
      active.current = null;
      if (!attempt.signal.aborted) setOpening(null);
    }
  };

  return <SheetModal visible title="Preview" onClose={close}>
    <ScrollView contentContainerStyle={workflowStyles.content}>
      {offline ? <Banner message="Connect to the internet to open a preview." /> : null}
      {ports.map(({ port, label }) => <Row key={port}
        title={label ?? `Port ${port}`}
        subtitle={opening === port ? 'Waiting for the app to start…' : label ? `Port ${port}` : undefined}
        trailing={opening === port ? <Spinner /> : undefined}
        chevron={opening !== port}
        disabled={offline || opening !== null}
        onPress={() => { void open(port); }} />)}
    </ScrollView>
  </SheetModal>;
}
