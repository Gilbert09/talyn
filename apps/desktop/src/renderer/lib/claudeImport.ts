import type { Workbench } from '@talyn/shared';
import type { ClaudeConversation, DesktopWorkbenchBridge } from '../../workbenchBridgeTypes';
import { api } from './api';
import { ensureChatHistory } from './workbenchData';
import { useNavigationStore } from '../stores/navigation';
import { useWorkbenchStore } from '../stores/workbenches';

/**
 * "Continue a Claude Code conversation": a new Claude sandbox session, the
 * conversation and the user's changes copied into it, then the session open.
 */

export type ClaudeImportStep = 'create' | 'wait' | 'prepare' | 'upload' | 'open';

export const CLAUDE_IMPORT_STEPS: ClaudeImportStep[] = ['create', 'wait', 'prepare', 'upload', 'open'];

export const CLAUDE_IMPORT_STEP_LABEL: Record<ClaudeImportStep, string> = {
  create: 'Create the sandbox session',
  wait: 'Wait for the sandbox',
  prepare: 'Read your changes',
  upload: 'Copy into the sandbox',
  open: 'Open the session',
};

export const CLAUDE_IMPORT_NOTICE =
  'This copies the conversation and your uncommitted changes into a cloud sandbox and into Talyn. It can include anything the agent printed, such as secrets.';

/** How long a new box may take to start before the import gives up. Matches a slow first clone. */
const READY_TIMEOUT_MS = 15 * 60_000;
const READY_POLL_MS = 4000;

export class ClaudeImportError extends Error {
  constructor(
    message: string,
    readonly step: ClaudeImportStep,
    /** The session, when it exists and was kept. */
    readonly workbenchId: string | null,
  ) {
    super(message);
  }
}

const messageOf = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

/** Resolve when the session is ready; reject when it fails, is archived, or takes too long. */
export function waitForReady(id: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<Workbench> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      unsubscribe();
      fn();
    };
    const check = (wb: Workbench | undefined) => {
      if (!wb) return;
      if (wb.status === 'ready') finish(() => resolve(wb));
      else if (wb.status === 'error') finish(() => reject(new Error(wb.statusMessage || 'The sandbox did not start.')));
      else if (wb.archivedAt) finish(() => reject(new Error('The session was archived.')));
    };
    const unsubscribe = useWorkbenchStore.subscribe((s) => check(s.workbenches[id]));
    const poll = setInterval(() => {
      void api.workbenches
        .get(id)
        .then((wb) => {
          useWorkbenchStore.getState().upsertWorkbench(wb);
          check(wb);
        })
        .catch(() => undefined);
    }, opts.pollMs ?? READY_POLL_MS);
    const timer = setTimeout(
      () => finish(() => reject(new Error('The sandbox took too long to start.'))),
      opts.timeoutMs ?? READY_TIMEOUT_MS,
    );
    check(useWorkbenchStore.getState().workbenches[id]);
  });
}

export interface ContinueClaudeConversationInput {
  bridge: Pick<DesktopWorkbenchBridge, 'claudeImport'>;
  conversation: ClaudeConversation;
  workspaceId: string;
  repositoryId: string;
  model?: string;
  internetAccess?: boolean;
  autoCreatePr?: boolean;
  onStep: (step: ClaudeImportStep) => void;
}

/**
 * Create → wait for the box (reading the changes meanwhile) → upload → open.
 * A failure before the upload removes the new session, so a failed import
 * leaves nothing behind. A failed upload keeps it: the box may already hold
 * part of the import, and the error names the step.
 */
export async function continueClaudeConversation(input: ContinueClaudeConversationInput): Promise<Workbench> {
  const { conversation } = input;
  if (!conversation.cwd) throw new ClaudeImportError('The conversation does not say which folder it ran in.', 'prepare', null);

  input.onStep('create');
  let wb: Workbench;
  try {
    wb = await api.workbenches.create({
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      runtime: 'sandbox',
      agent: 'claude',
      ...(input.model ? { model: input.model } : {}),
      ...(input.internetAccess === undefined ? {} : { internetAccess: input.internetAccess }),
      ...(input.autoCreatePr === undefined ? {} : { autoCreatePr: input.autoCreatePr }),
    });
  } catch (err) {
    throw new ClaudeImportError(messageOf(err, 'Could not create the session.'), 'create', null);
  }
  useWorkbenchStore.getState().upsertWorkbench(wb);

  const discard = () => api.workbenches.remove(wb.id).then(() => useWorkbenchStore.getState().removeWorkbench(wb.id)).catch(() => undefined);
  input.onStep('wait');
  const prepared = input.bridge.claudeImport.prepare({ sessionId: conversation.sessionId, cwd: conversation.cwd });
  // Read in parallel with the boot; a rejection is reported below, in order.
  prepared.catch(() => undefined);
  try {
    await waitForReady(wb.id);
  } catch (err) {
    await discard();
    throw new ClaudeImportError(messageOf(err, 'The sandbox did not start.'), 'wait', null);
  }
  input.onStep('prepare');
  let body: Uint8Array;
  try {
    body = (await prepared).body;
  } catch (err) {
    await discard();
    throw new ClaudeImportError(messageOf(err, 'Could not read your changes.'), 'prepare', null);
  }

  input.onStep('upload');
  let result: Awaited<ReturnType<typeof api.workbenches.import>>;
  try {
    result = await api.workbenches.import(wb.id, body);
  } catch (err) {
    throw new ClaudeImportError(messageOf(err, 'Could not copy the conversation into the sandbox.'), 'upload', wb.id);
  }

  input.onStep('open');
  const store = useWorkbenchStore.getState();
  store.upsertChat(result.chat);
  store.setChatEventsState(result.chat.id, { events: [], loaded: false, hasOlder: false, oldestSeq: null, error: null });
  store.selectChat(wb.id, result.chat.id);
  void ensureChatHistory(result.chat.id);
  useNavigationStore.getState().navigate({ view: 'workbench', id: wb.id });
  return wb;
}
