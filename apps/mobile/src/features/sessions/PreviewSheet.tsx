import { ApiError } from '@talyn/client/native';
import type { PreviewPort, Workbench } from '@talyn/shared';
import { useEffect, useRef, useState } from 'react';
import { ScrollView } from 'react-native';

import { useMobileRuntime, useNetwork } from '../../auth/AuthProvider';
import { Banner, Row, SheetModal, Spinner } from '../../components/UI';
import { openExternal, safeExternalUrl, workflowStyles } from '../../components/Workflow';
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
    const { signal } = attempt;
    const deadline = Date.now() + START_TIMEOUT_MS;
    const timeoutError = new Error(`Talyn could not prepare the preview on port ${port} within 10 minutes.`);
    const cancelError = new Error('Preview cancelled.');
    let timedOut = false;
    let rejectAttempt!: (error: Error) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectAttempt = reject; });
    const onAbort = () => rejectAttempt(timedOut ? timeoutError : cancelError);
    signal.addEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      timedOut = true;
      attempt.abort();
    }, START_TIMEOUT_MS);
    const checkDeadline = () => {
      if (signal.aborted) throw cancelError;
      if (Date.now() >= deadline) throw timeoutError;
    };
    const prepare = async () => {
      const { id } = item;
      let status = await api.previewStatus(id, port, { signal });
      checkDeadline();
      if (!status.ready && !status.running) {
        try {
          await api.runScript(id, 'run', { signal });
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'script_running') throw error;
        }
      }
      let stoppedSince: number | undefined;
      while (!status.ready) {
        checkDeadline();
        status = await api.previewStatus(id, port, { live: true, signal });
        checkDeadline();
        if (status.ready) break;
        const now = Date.now();
        stoppedSince = status.running ? undefined : stoppedSince ?? now;
        if (stoppedSince !== undefined && now - stoppedSince >= STOPPED_GRACE_MS) {
          throw new Error('The run script stopped before the app answered.');
        }
        await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
      }
      return api.previewLink(id, port, { signal });
    };
    try {
      const link = await Promise.race([prepare(), interrupted]);
      checkDeadline();
      const url = safeExternalUrl(link.url);
      if (!url) throw new Error('Talyn returned an invalid preview link.');
      openExternal(url, { originOnly: true, onOpened: onClose });
    } catch (error) {
      if (timedOut || !signal.aborted) showActionError('Could not open the preview', timedOut ? timeoutError : error);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      active.current = null;
      if (timedOut || !signal.aborted) setOpening(null);
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
