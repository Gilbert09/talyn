import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Loader2, Square, X } from 'lucide-react';
import {
  DEFAULT_WORKBENCH_EFFORT,
  WORKBENCH_MOVING_MESSAGE,
  type Workbench,
  type WorkbenchAgent,
  type WorkbenchCapacityWait,
  type WorkbenchChat,
  type WorkbenchContextUsage,
  type WorkbenchEffort,
  type WorkbenchQueuedMessage,
  type WorkbenchTodo,
  workbenchQueuesMessages,
} from '@talyn/shared';
import { promptRefusal, useIsWorkbenchOwner } from '../../lib/spaces';
import { cn } from '../../lib/utils';
import { api } from '../../lib/api';
import { wakeWorkbench } from '../../lib/wakeWorkbench';
import { trackEvent } from '../../lib/analytics';
import { captureWorkbenchFailure } from '../../lib/workbenchAnalytics';
import { CLAUDE_HEADLESS_SLASH_COMMANDS, fuzzyMatchPaths, slashCommandsFrom } from '../../lib/workbenchFormat';
import { FOCUS_COMPOSER_EVENT } from '../../lib/shortcuts';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { toast } from '../../stores/toast';
import { maybeHandleBillingLimit } from '../../stores/billing';
import { composerDraftKey, useWorkbenchStore } from '../../stores/workbenches';
import { createChatTab } from './ChatTabs';
import { ComposerPopover, applyTrigger, findTrigger, type ComposerMentionSource, type ComposerTrigger } from './ComposerPopover';
import { isThread, threadMentions } from '../../lib/threads';
import { useWorkspaceStore } from '../../stores/workspace';
import { useThreadChildren } from './workbenchSelectors';
import { AgentPicker, ContextMeter, EffortPicker, ModelPicker, PlanToggle, TodoChip, defaultModelFor } from './ComposerControls';
import { ImageAttachButton, ImageAttachmentChips, useComposerImages } from './useComposerImages';

let outgoingMessageSequence = 0;

export function Composer({
  workbench,
  chat,
  ops,
  todos,
  contextUsage,
  slashCommands,
}: {
  workbench: Workbench;
  chat: WorkbenchChat | null;
  ops: WorkbenchOps;
  todos: WorkbenchTodo[] | null;
  contextUsage: WorkbenchContextUsage | null;
  slashCommands: string[] | null;
}) {
  const draftKey = composerDraftKey(workbench.id, chat);
  const draft = useWorkbenchStore((s) => s.drafts[draftKey] ?? '');
  const setDraft = useWorkbenchStore((s) => s.setDraft);
  const localQueue = useWorkbenchStore((s) => (chat ? s.localQueues[chat.id] : undefined));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const images = useComposerImages(ops.runtime, ops, workbench.status);
  const { attachments, setAttachments, pendingUploads, imageNotReady, setImageNotReady, fileInputRef, attachFiles, onPaste, onDrop } = images;
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [active, setActive] = useState(0);
  const [paths, setPaths] = useState<string[] | null>(null);
  const [pathsLoading, setPathsLoading] = useState(false);
  // A thread has no files: its `@` offers repositories and its live sessions.
  const thread = isThread(workbench);
  const repositories = useWorkspaceStore((s) => s.repositories);
  const threadSessions = useThreadChildren(workbench.id);

  const agent = chat?.agent ?? workbench.agent;
  const model = chat?.model ?? defaultModelFor(agent);
  const effort = chat?.effort ?? DEFAULT_WORKBENCH_EFFORT;
  const planMode = chat?.planMode ?? false;
  const running = chat?.status === 'running';
  const queue = ops.runtime === 'local' ? (localQueue ?? []) : (chat?.queuedMessages ?? []);
  const waitText = sandboxWaitText(workbench);
  // Only the owner can change chat settings or wake the sandbox while typing.
  const owner = useIsWorkbenchOwner(workbench);
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => setRefusal(null), [workbench.id, chat?.id]);

  useEffect(() => {
    setPaths(null);
  }, [workbench.id]);

  useEffect(() => {
    if (workbench.status === 'ready' || workbench.status === 'moving') setImageNotReady(false);
  }, [workbench.status]);

  // Autosize: grow with the text up to a third of the window, then scroll.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight / 3))}px`;
  }, [draft]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [draftKey]);

  // ⌘L (lib/shortcuts.ts) asks the open composer for focus.
  useEffect(() => {
    const onFocusRequest = () => textareaRef.current?.focus();
    window.addEventListener(FOCUS_COMPOSER_EVENT, onFocusRequest);
    return () => window.removeEventListener(FOCUS_COMPOSER_EVENT, onFocusRequest);
  }, []);

  const loadPaths = () => {
    if (thread || paths || pathsLoading || ops.unavailable) return;
    setPathsLoading(true);
    ops
      .listFiles()
      .then(setPaths)
      .catch(() => setPaths([]))
      .finally(() => setPathsLoading(false));
  };

  const mentionOptions = useMemo(
    () => (thread && trigger?.kind === 'mention' ? threadMentions(trigger.query, repositories, threadSessions) : null),
    [thread, trigger, repositories, threadSessions]
  );
  const mentionSource = useMemo<ComposerMentionSource | undefined>(
    () =>
      mentionOptions
        ? {
            heading: 'Sessions and repositories',
            empty: 'No matching session or repository.',
            labels: Object.fromEntries(mentionOptions.map((m) => [m.value, m.label])),
          }
        : undefined,
    [mentionOptions]
  );

  const items = useMemo(() => {
    if (!trigger) return [];
    if (mentionOptions) return mentionOptions.map((m) => m.value);
    if (trigger.kind === 'mention') return fuzzyMatchPaths(trigger.query, paths ?? []);
    const fileCommands = slashCommandsFrom(paths ?? []);
    const commands = agent === 'codex'
      ? fileCommands
      : [...new Set([...(slashCommands ?? CLAUDE_HEADLESS_SLASH_COMMANDS), ...fileCommands])].sort();
    const q = trigger.query.toLowerCase();
    return commands
      .filter((c) => c.toLowerCase().includes(q))
      .sort((a, b) => Number(b.toLowerCase().startsWith(q)) - Number(a.toLowerCase().startsWith(q)))
      .slice(0, 20);
  }, [trigger, paths, slashCommands, agent, mentionOptions]);

  const updateTrigger = (text: string, caret: number) => {
    const next = findTrigger(text, caret);
    setTrigger(next);
    setActive(0);
    if (next) loadPaths();
  };

  const pick = (item: string) => {
    if (!trigger) return;
    const { text, caret } = applyTrigger(draft, trigger, item);
    setDraft(draftKey, text);
    setTrigger(null);
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  };

  const patchChat = async (patch: { agent?: WorkbenchAgent; model?: string; effort?: WorkbenchEffort | null; planMode?: boolean }) => {
    if (!chat) return;
    const previous = chat;
    useWorkbenchStore.getState().upsertChat({ ...chat, ...patch });
    try {
      useWorkbenchStore.getState().upsertChat(await api.workbenches.updateChat(chat.id, patch));
    } catch (err) {
      useWorkbenchStore.getState().upsertChat(previous);
      captureWorkbenchFailure('update_chat_settings', err, workbench.id);
      toast.error('Could not save the chat setting', err instanceof Error ? err.message : undefined);
    }
  };

  // A session whose sandbox is starting, moving or being replaced still takes
  // messages: the backend queues them and runs them when the sandbox is ready.
  const sendBlocked =
    Boolean(ops.unavailable) &&
    !workbenchQueuesMessages(workbench.status) &&
    !(workbench.status === 'ready' && workbench.sandboxState === 'lost');

  const send = async () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || sending || pendingUploads > 0 || sendBlocked) return;
    if (!owner && !chat) return;
    setSending(true);
    setRefusal(null);
    let outgoingId: string | null = null;
    let outgoingChatId: string | null = null;
    try {
      const target = chat ?? (await createChatTab(workbench));
      if (!target) return;
      outgoingMessageSequence += 1;
      outgoingId = `outgoing-${Date.now()}-${outgoingMessageSequence}`;
      outgoingChatId = target.id;
      useWorkbenchStore.getState().addOutgoingMessage(target.id, {
        id: outgoingId,
        text,
        attachments: attachments.slice(),
      });
      setDraft(draftKey, '');
      setAttachments([]);
      setImageNotReady(false);
      setTrigger(null);
      const res = await ops.send(target, {
        text,
        attachments: attachments.length ? attachments : undefined,
        planMode,
        model,
        effort,
      });
      trackEvent('session_message_sent', { queued: res.queued, plan_mode: planMode, model_id: model, attachments_count: attachments.length });
      if (res.queued && workbench.status !== 'moving') {
        toast.info(
          'Queued',
          workbench.status === 'provisioning' ? 'It runs when the sandbox is ready.' : 'It runs when the current turn ends.'
        );
      }
    } catch (err) {
      captureWorkbenchFailure('send_message', err, workbench.id);
      setDraft(draftKey, text);
      const refused = owner ? null : promptRefusal(err);
      if (refused) {
        setRefusal(refused);
        return;
      }
      if (maybeHandleBillingLimit(err, 'workbench_send')) return;
      // A 409 not_ready carries the server's own reason (the sandbox failed or is still starting).
      toast.error('Could not send the message', err instanceof Error ? err.message : undefined);
    } finally {
      if (outgoingId && outgoingChatId) useWorkbenchStore.getState().removeOutgoingMessage(outgoingChatId, outgoingId);
      setSending(false);
    }
  };

  const stop = async () => {
    if (!chat) return;
    setStopping(true);
    try {
      await ops.cancel(chat.id);
    } catch (err) {
      captureWorkbenchFailure('stop_agent', err, workbench.id);
      toast.error('Could not stop the agent', err instanceof Error ? err.message : undefined);
    } finally {
      setStopping(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (trigger && (items.length > 0 || e.key === 'Escape')) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % Math.max(1, items.length));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + items.length) % Math.max(1, items.length));
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && items[active]) {
        e.preventDefault();
        pick(items[active]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setTrigger(null);
        return;
      }
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      if (owner) void patchChat({ planMode: !planMode });
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="border-t bg-background px-3 pb-3 pt-2" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {queue.length > 0 && (
        <ul className="mb-2 space-y-1">
          {queue.map((m, index) => m.capacityWait ? (
            <CapacityWaitLine key={m.id} message={m} wait={m.capacityWait} chatId={chat?.id} ops={ops} />
          ) : (
            <li key={m.id} data-attr={index === 0 && waitText ? 'workbench-sandbox-wait' : undefined} className="flex items-center gap-2 rounded border border-dashed px-2 py-1 text-xs text-muted-foreground">
              {index === 0 && waitText && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
              <span className="shrink-0 text-[10px] uppercase tracking-wide">{m.origin === 'talyn' ? 'From Talyn' : index === 0 && waitText ? 'Waiting' : 'Queued'}</span>
              {index === 0 && waitText ? (
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{m.text}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{waitText}</span>
                </span>
              ) : <span className="min-w-0 flex-1 truncate">{m.text}</span>}
              {ops.canRemoveQueued && chat && (
                <button
                  type="button"
                  onClick={() => ops.removeQueued(chat.id, m.id)}
                  className="rounded p-0.5 hover:bg-accent hover:text-foreground"
                  aria-label="Remove the queued message"
                  title="Remove"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!owner && (
        <p className="mb-1.5 text-[11px] text-muted-foreground" data-attr="composer-payer-note">
          Runs on your subscription and your box-hours
        </p>
      )}
      {refusal && (
        <p role="alert" className="mb-1.5 text-xs text-destructive" data-attr="composer-refusal">
          {refusal}
        </p>
      )}
      <div
        className={cn('relative rounded-lg border bg-background focus-within:ring-1 focus-within:ring-ring', planMode && 'border-sky-500/60')}>
        {trigger && (
          <ComposerPopover
            kind={trigger.kind}
            items={items}
            active={active}
            loading={pathsLoading}
            onPick={pick}
            onHover={setActive}
            mentions={mentionSource}
          />
        )}
        <ImageAttachmentChips attachments={attachments} pendingUploads={pendingUploads} imageNotReady={imageNotReady} onRemove={(index) => setAttachments((current) => current.filter((_, i) => i !== index))} />
        <textarea
          data-session-composer
          ref={textareaRef}
          value={draft}
          rows={1}
          disabled={sendBlocked}
          onChange={(e) => {
            setDraft(draftKey, e.target.value);
            if (owner) wakeWorkbench(workbench.id);
            if (refusal) setRefusal(null);
            updateTrigger(e.target.value, e.target.selectionStart);
          }}
          onClick={(e) => updateTrigger(draft, e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => setTrigger(null)}
          placeholder={
            ops.unavailable ??
            (running ? 'The agent is working. A message now is queued for when it finishes.' : 'Ask the agent… (@ for files, / for commands)')
          }
          className="block max-h-[33vh] w-full resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          aria-label="Message the agent"
        />
        <div className="flex items-center gap-1 px-2 pb-1.5">
          <ImageAttachButton inputRef={fileInputRef} onFiles={(files) => void attachFiles(files)} />
          <AgentPicker value={agent} onChange={(next) => void patchChat({ agent: next, model: defaultModelFor(next) })} disabled={!owner || !chat || Boolean(ops.unavailable) || ops.runtime === 'local'} />
          <ModelPicker agent={agent} value={model} onChange={(m) => void patchChat({ model: m })} disabled={!owner || !chat || Boolean(ops.unavailable)} />
          <EffortPicker value={effort} onChange={(v) => void patchChat({ effort: v })} disabled={!owner || !chat || Boolean(ops.unavailable)} />
          <PlanToggle on={planMode} onToggle={() => void patchChat({ planMode: !planMode })} disabled={!owner || !chat || Boolean(ops.unavailable)} />
          <TodoChip todos={todos} />
          <div className="flex-1" />
          <ContextMeter usage={contextUsage} />
          {running && owner ? (
            <button
              type="button"
              onClick={() => void stop()}
              disabled={stopping}
              className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              title="Stop the agent"
              aria-label="Stop the agent"
            >
              {stopping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3 w-3" fill="currentColor" />}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || pendingUploads > 0 || sendBlocked || (!draft.trim() && attachments.length === 0)}
            className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            title={running ? 'Queue (Enter)' : 'Send (Enter)'}
            aria-label={running ? 'Queue the message' : 'Send the message'}
          >
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The wait-for-a-sandbox text, with the seconds until the next try. */
export function capacityWaitText(wait: WorkbenchCapacityWait, now: number): string {
  if (wait.reason === 'waking') return 'Waking the sandbox…';
  const seconds = Math.max(0, Math.ceil((new Date(wait.retryAt).getTime() - now) / 1000));
  return Number.isFinite(seconds) && seconds > 0
    ? `Waiting for a free sandbox… (retrying in ${seconds}s)`
    : 'Waiting for a free sandbox…';
}

export function sandboxWaitText(workbench: Workbench): string | null {
  const statusMessage = workbench.statusMessage?.trim().replace(/[….]+$/, '').trim();
  if (workbench.status === 'provisioning') {
    return statusMessage ? `Waiting for the sandbox to start: ${statusMessage}` : 'Waiting for the sandbox to start…';
  }
  if (workbench.status === 'moving') {
    return statusMessage ? `Waiting for the sandbox: ${statusMessage}` : WORKBENCH_MOVING_MESSAGE;
  }
  return null;
}

/** A message that waits for a sandbox is the turn in progress, so it is a status line and not a queued chip. */
function CapacityWaitLine({ message, wait, chatId, ops }: { message: WorkbenchQueuedMessage; wait: WorkbenchCapacityWait; chatId: string | undefined; ops: WorkbenchOps }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <li data-attr="workbench-capacity-wait" className="flex items-center gap-2 rounded border border-dashed px-2 py-1 text-xs text-muted-foreground">
      <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      <span className="min-w-0 flex-1 truncate">{capacityWaitText(wait, now)}</span>
      {ops.canRemoveQueued && chatId && (
        <button
          type="button"
          onClick={() => ops.removeQueued(chatId, message.id)}
          className="rounded p-0.5 hover:bg-accent hover:text-foreground"
          aria-label="Stop waiting"
          title="Stop waiting"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </li>
  );
}
