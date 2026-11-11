import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Loader2, Square, X } from 'lucide-react';
import {
  DEFAULT_WORKBENCH_EFFORT,
  fleetModelForAgentSwitch,
  messageTriggerText,
  TALYN_SKILL_PACK,
  WORKBENCH_MOVING_MESSAGE,
  type SendWorkbenchMessageInput,
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
import {
  CLAUDE_HEADLESS_SLASH_COMMANDS,
  fuzzyMatchPaths,
  knownSlashCommandDescription,
  sendFailureText,
  slashCommandFiles,
} from '../../lib/workbenchFormat';
import { composerSettingsLinks, matchComposerLinks } from '../../lib/composerLinks';
import { useNavigationStore } from '../../stores/navigation';
import { FOCUS_COMPOSER_EVENT } from '../../lib/shortcuts';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { toast } from '../../stores/toast';
import { maybeHandleBillingLimit } from '../../stores/billing';
import { composerDraftKey, useWorkbenchStore } from '../../stores/workbenches';
import { createChatTab } from './ChatTabs';
import { useSlashCommandFileDescriptions } from './useSlashCommandFileDescriptions';
import { ComposerPopover, applyTrigger, findTrigger, type ComposerMentionSource, type ComposerTrigger } from './ComposerPopover';
import { isThread, threadMentions } from '../../lib/threads';
import { useWorkspaceStore } from '../../stores/workspace';
import { useThreadChildren } from './workbenchSelectors';
import { AgentPicker, ContextMeter, EffortPicker, ModelPicker, PlanToggle, TodoChip, defaultModelFor } from './ComposerControls';
import { ImageAttachButton, ImageAttachmentChips, useComposerImages } from './useComposerImages';
import { BackgroundChips } from './BackgroundChips';
import { WakeLaterPopover } from './WakeLaterPopover';


export function Composer({
  workbench,
  chat,
  ops,
  todos,
  contextUsage,
  slashCommands,
  attachRef,
  autoFocus = true,
}: {
  workbench: Workbench;
  chat: WorkbenchChat | null;
  ops: WorkbenchOps;
  todos: WorkbenchTodo[] | null;
  contextUsage: WorkbenchContextUsage | null;
  slashCommands: string[] | null;
  /** Set by the composer so a drop zone around it can attach images. */
  attachRef?: React.MutableRefObject<((files: File[]) => void) | null>;
  /**
   * Take focus on open and answer ⌘L. Split view shows several composers and
   * passes true only to the focused pane's, so they do not fight over the caret.
   */
  autoFocus?: boolean;
}) {
  const draftKey = composerDraftKey(workbench.id, chat);
  const draft = useWorkbenchStore((s) => s.drafts[draftKey] ?? '');
  const setDraft = useWorkbenchStore((s) => s.setDraft);
  const localQueue = useWorkbenchStore((s) => (chat ? s.localQueues[chat.id] : undefined));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const images = useComposerImages(ops.runtime, ops, workbench.status);
  const { attachments, setAttachments, pendingUploads, imageNotReady, setImageNotReady, fileInputRef, attachFiles, onPaste } = images;
  useEffect(() => {
    if (attachRef) attachRef.current = (files) => void attachFiles(files);
  });
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [active, setActive] = useState(0);
  const [paths, setPaths] = useState<string[] | null>(null);
  const [pathsLoading, setPathsLoading] = useState(false);
  // A thread has no files: its `@` offers repositories and its live sessions.
  const thread = isThread(workbench);
  const repositories = useWorkspaceStore((s) => s.repositories);
  const threadSessions = useThreadChildren(workbench.id);
  const features = useWorkspaceStore((s) => s.features);
  const talynSkillsEnabled = useWorkspaceStore(
    (s) => s.workspaces.find((workspace) => workspace.id === workbench.workspaceId)?.settings.sessionSkillPack !== false,
  );
  const navigate = useNavigationStore((s) => s.navigate);

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
    if (autoFocus) textareaRef.current?.focus();
  }, [draftKey]);

  // ⌘L (lib/shortcuts.ts) asks the open composer for focus.
  useEffect(() => {
    if (!autoFocus) return undefined;
    const onFocusRequest = () => textareaRef.current?.focus();
    window.addEventListener(FOCUS_COMPOSER_EVENT, onFocusRequest);
    return () => window.removeEventListener(FOCUS_COMPOSER_EVENT, onFocusRequest);
  }, [autoFocus]);

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

  const commandFiles = useMemo(() => slashCommandFiles(paths ?? []), [paths]);
  const fileDescriptions = useSlashCommandFileDescriptions(ops, workbench.id, commandFiles, trigger?.kind === 'slash');

  const items = useMemo(() => {
    if (!trigger) return [];
    if (mentionOptions) return mentionOptions.map((m) => m.value);
    if (trigger.kind === 'mention') return fuzzyMatchPaths(trigger.query, paths ?? []);
    const fileCommands = Object.keys(commandFiles).sort();
    const commands = agent === 'codex'
      ? [...new Set([...(talynSkillsEnabled ? TALYN_SKILL_PACK : []), ...fileCommands])].sort()
      : [...new Set([...(slashCommands ?? CLAUDE_HEADLESS_SLASH_COMMANDS), ...fileCommands])].sort();
    const q = trigger.query.toLowerCase();
    return commands
      .filter((c) => c.toLowerCase().includes(q))
      .sort((a, b) => Number(b.toLowerCase().startsWith(q)) - Number(a.toLowerCase().startsWith(q)))
      .slice(0, 20);
  }, [trigger, commandFiles, slashCommands, agent, mentionOptions, talynSkillsEnabled]);

  const descriptions = useMemo(() => {
    if (trigger?.kind !== 'slash') return undefined;
    const out: Record<string, string> = {};
    for (const item of items) {
      const description = fileDescriptions[item] ?? knownSlashCommandDescription(item);
      if (description) out[item] = description;
    }
    return out;
  }, [trigger, items, fileDescriptions]);

  const links = useMemo(
    () => (trigger?.kind === 'slash' ? matchComposerLinks(composerSettingsLinks(features), trigger.query) : []),
    [trigger, features],
  );
  const optionCount = items.length + links.length;

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

  const pickLink = (id: string) => {
    const link = links.find((l) => l.id === id);
    if (!trigger || !link) return;
    setDraft(draftKey, draft.slice(0, trigger.start) + draft.slice(trigger.end));
    setTrigger(null);
    trackEvent('composer_settings_link_opened', { link: id });
    navigate(link.route);
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
    const input: SendWorkbenchMessageInput = {
      text,
      attachments: attachments.length ? attachments.slice() : undefined,
      planMode,
      model,
      effort,
    };
    try {
      const target = chat ?? (await createChatTab(workbench));
      if (!target) return;
      outgoingChatId = target.id;
      outgoingId = useWorkbenchStore.getState().addOutgoingMessage(target.id, { text, attachments: attachments.slice() });
      setDraft(draftKey, '');
      setAttachments([]);
      setImageNotReady(false);
      setTrigger(null);
      const res = await ops.send(target, input);
      useWorkbenchStore.getState().settleOutgoingMessage(target.id, outgoingId);
      trackEvent('session_message_sent', { queued: res.queued, plan_mode: planMode, model_id: model, attachments_count: attachments.length });
      if (res.queued && workbench.status !== 'moving') {
        toast.info(
          'Queued',
          workbench.status === 'provisioning' ? 'It runs when the sandbox is ready.' : 'It runs when the current turn ends.'
        );
      }
    } catch (err) {
      captureWorkbenchFailure('send_message', err, workbench.id);
      // A box refusal (out of hours, every box busy) opens the plan modal with
      // its own sentence and action, and a prompt refusal shows its reason:
      // the text goes back to the composer.
      const refused = owner ? null : promptRefusal(err);
      const limited = !refused && maybeHandleBillingLimit(err, 'workbench_send');
      if (limited || refused || !outgoingId || !outgoingChatId) {
        if (outgoingId && outgoingChatId) useWorkbenchStore.getState().removeOutgoingMessages(outgoingChatId, [outgoingId]);
        setDraft(draftKey, text);
        if (refused) setRefusal(refused);
        if (limited || refused) return;
      } else {
        // Any other failure (the backend is down, the sandbox is not ready):
        // the message stays in the chat with the error and a Retry action.
        useWorkbenchStore.getState().failOutgoingMessage(outgoingChatId, outgoingId, { error: sendFailureText(err), input });
      }
      // A 409 not_ready carries the server's own reason (the sandbox failed or is still starting).
      toast.error('Could not send the message', err instanceof Error ? err.message : undefined);
    } finally {
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
    if (trigger && (optionCount > 0 || e.key === 'Escape')) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % Math.max(1, optionCount));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + optionCount) % Math.max(1, optionCount));
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && active < optionCount) {
        e.preventDefault();
        if (active < items.length) pick(items[active]);
        else pickLink(links[active - items.length].id);
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
    <div className="border-t bg-background px-3 pb-3 pt-2">
      <BackgroundChips workbenchId={workbench.id} chatId={chat?.id ?? null} canOpen={owner} />
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
                  <span className="block truncate">{m.trigger ? messageTriggerText(m.trigger) : m.text}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{waitText}</span>
                </span>
              ) : <span className="min-w-0 flex-1 truncate">{m.trigger ? messageTriggerText(m.trigger) : m.text}</span>}
              {ops.canRemoveQueued && chat && (
                <button
                  type="button"
                  onClick={() => removeQueued(ops, chat.id, m)}
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
            descriptions={descriptions}
            links={links}
            onPickLink={pickLink}
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
          <AgentPicker value={agent} onChange={(next) => void patchChat({ agent: next, model: fleetModelForAgentSwitch(model, next) })} disabled={!owner || !chat || Boolean(ops.unavailable) || ops.runtime === 'local'} />
          <ModelPicker agent={agent} value={model} onChange={(m) => void patchChat({ model: m })} disabled={!owner || !chat || Boolean(ops.unavailable)} />
          <EffortPicker value={effort} onChange={(v) => void patchChat({ effort: v })} disabled={!owner || !chat || Boolean(ops.unavailable)} />
          <PlanToggle on={planMode} onToggle={() => void patchChat({ planMode: !planMode })} disabled={!owner || !chat || Boolean(ops.unavailable)} />
          <TodoChip todos={todos} />
          {owner && chat && <WakeLaterPopover workbenchId={workbench.id} chatId={chat.id} />}
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

/** Remove a queued message, and the transcript's pending copy of it. */
function removeQueued(ops: WorkbenchOps, chatId: string, message: WorkbenchQueuedMessage) {
  const store = useWorkbenchStore.getState();
  const text = message.text.trim();
  const copies = (store.outgoingMessages[chatId] ?? []).filter((o) => o.text.trim() === text).map((o) => o.id);
  if (copies.length) store.removeOutgoingMessages(chatId, copies);
  ops.removeQueued(chatId, message.id);
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
          onClick={() => removeQueued(ops, chatId, message)}
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
