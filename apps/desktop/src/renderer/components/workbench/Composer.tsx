import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, ImageIcon, Loader2, Square, X } from 'lucide-react';
import type {
  Workbench,
  WorkbenchAttachment,
  WorkbenchChat,
  WorkbenchContextUsage,
  WorkbenchEffort,
  WorkbenchTodo,
} from '@talyn/shared';
import { cn } from '../../lib/utils';
import { api } from '../../lib/api';
import { downscaleImage } from '../../lib/imageDownscale';
import { fuzzyMatchPaths, slashCommandsFrom } from '../../lib/workbenchFormat';
import { FOCUS_COMPOSER_EVENT } from '../../lib/shortcuts';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { toast } from '../../stores/toast';
import { composerDraftKey, useWorkbenchStore } from '../../stores/workbenches';
import { createChatTab } from './ChatTabs';
import { ComposerPopover, applyTrigger, findTrigger, type ComposerTrigger } from './ComposerPopover';
import { ContextMeter, EffortPicker, ModelPicker, PlanToggle, TodoChip, defaultModelFor } from './ComposerControls';

const SANDBOX_ATTACHMENT_NOTE =
  '(I pasted an image here, but sandbox workbenches cannot take attachments yet, so it was not sent.)';

export function Composer({
  workbench,
  chat,
  ops,
  todos,
  contextUsage,
}: {
  workbench: Workbench;
  chat: WorkbenchChat | null;
  ops: WorkbenchOps;
  todos: WorkbenchTodo[] | null;
  contextUsage: WorkbenchContextUsage | null;
}) {
  const draftKey = composerDraftKey(workbench.id, chat);
  const draft = useWorkbenchStore((s) => s.drafts[draftKey] ?? '');
  const setDraft = useWorkbenchStore((s) => s.setDraft);
  const localQueue = useWorkbenchStore((s) => (chat ? s.localQueues[chat.id] : undefined));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [attachments, setAttachments] = useState<WorkbenchAttachment[]>([]);
  const [droppedImage, setDroppedImage] = useState(false);
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [active, setActive] = useState(0);
  const [paths, setPaths] = useState<string[] | null>(null);
  const [pathsLoading, setPathsLoading] = useState(false);

  const model = chat?.model ?? defaultModelFor(workbench.agent);
  const effort = chat?.effort ?? null;
  const planMode = chat?.planMode ?? false;
  const running = chat?.status === 'running';
  const queue = ops.runtime === 'local' ? (localQueue ?? []) : (chat?.queuedMessages ?? []);

  useEffect(() => {
    setPaths(null);
  }, [workbench.id]);

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
    if (paths || pathsLoading || ops.unavailable) return;
    setPathsLoading(true);
    ops
      .listFiles()
      .then(setPaths)
      .catch(() => setPaths([]))
      .finally(() => setPathsLoading(false));
  };

  const items = useMemo(() => {
    if (!trigger) return [];
    if (trigger.kind === 'mention') return fuzzyMatchPaths(trigger.query, paths ?? []);
    const commands = slashCommandsFrom(paths ?? []);
    const q = trigger.query.toLowerCase();
    return commands.filter((c) => c.toLowerCase().includes(q)).slice(0, 20);
  }, [trigger, paths]);

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

  const patchChat = async (patch: { model?: string; effort?: WorkbenchEffort | null; planMode?: boolean }) => {
    if (!chat) return;
    useWorkbenchStore.getState().upsertChat({ ...chat, ...patch });
    try {
      useWorkbenchStore.getState().upsertChat(await api.workbenches.updateChat(chat.id, patch));
    } catch (err) {
      toast.error('Could not save the chat setting', err instanceof Error ? err.message : undefined);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || sending || ops.unavailable) return;
    setSending(true);
    try {
      const target = chat ?? (await createChatTab(workbench));
      if (!target) return;
      const body = droppedImage ? `${text}\n\n${SANDBOX_ATTACHMENT_NOTE}` : text;
      setDraft(draftKey, '');
      setAttachments([]);
      setDroppedImage(false);
      setTrigger(null);
      const res = await ops.send(target, {
        text: body,
        attachments: attachments.length ? attachments : undefined,
        planMode,
        model,
        effort: effort ?? undefined,
      });
      if (res.queued) {
        toast.info(
          'Queued',
          workbench.status === 'provisioning' ? 'It runs when the sandbox is ready.' : 'It runs when the current turn ends.'
        );
      }
    } catch (err) {
      setDraft(draftKey, text);
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
      toast.error('Could not stop the agent', err instanceof Error ? err.message : undefined);
    } finally {
      setStopping(false);
    }
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.items]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault();
    if (!ops.canAttach) {
      setDroppedImage(true);
      return;
    }
    for (const file of files) {
      try {
        const dataUrl = await downscaleImage(file, 1600);
        const dataBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
        const attachment = await ops.attach({ name: file.name || 'pasted.png', mimeType: 'image/png', dataBase64 });
        setAttachments((cur) => [...cur, attachment]);
      } catch (err) {
        toast.error('Could not attach the image', err instanceof Error ? err.message : undefined);
      }
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
      void patchChat({ planMode: !planMode });
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="border-t bg-background px-3 pb-3 pt-2">
      {queue.length > 0 && (
        <ul className="mb-2 space-y-1">
          {queue.map((m) => (
            <li key={m.id} className="flex items-center gap-2 rounded border border-dashed px-2 py-1 text-xs text-muted-foreground">
              <span className="shrink-0 text-[10px] uppercase tracking-wide">Queued</span>
              <span className="min-w-0 flex-1 truncate">{m.text}</span>
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
      <div className={cn('relative rounded-lg border bg-background focus-within:ring-1 focus-within:ring-ring', planMode && 'border-sky-500/60')}>
        {trigger && (
          <ComposerPopover kind={trigger.kind} items={items} active={active} loading={pathsLoading} onPick={pick} onHover={setActive} />
        )}
        {(attachments.length > 0 || droppedImage) && (
          <div className="flex flex-wrap gap-1 px-2 pt-2">
            {attachments.map((a, i) => (
              <span key={`${a.path}-${i}`} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px]">
                <ImageIcon className="h-3 w-3" />
                {a.name}
                <button
                  type="button"
                  onClick={() => setAttachments((cur) => cur.filter((_, j) => j !== i))}
                  aria-label={`Remove ${a.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {droppedImage && (
              <span className="text-[11px] text-amber-700 dark:text-amber-400">
                Sandbox workbenches cannot take images yet. The message will say so.
              </span>
            )}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          disabled={Boolean(ops.unavailable)}
          onChange={(e) => {
            setDraft(draftKey, e.target.value);
            updateTrigger(e.target.value, e.target.selectionStart);
          }}
          onClick={(e) => updateTrigger(draft, e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(e) => void onPaste(e)}
          onBlur={() => setTrigger(null)}
          placeholder={
            ops.unavailable ??
            (running ? 'The agent is working. A message now is queued for when it finishes.' : 'Ask the agent… (@ for files, / for commands)')
          }
          className="block max-h-[33vh] w-full resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          aria-label="Message the agent"
        />
        <div className="flex items-center gap-1 px-2 pb-1.5">
          <ModelPicker agent={workbench.agent} value={model} onChange={(m) => void patchChat({ model: m })} disabled={!chat || Boolean(ops.unavailable)} />
          <EffortPicker value={effort} onChange={(v) => void patchChat({ effort: v })} disabled={!chat || Boolean(ops.unavailable)} />
          <PlanToggle on={planMode} onToggle={() => void patchChat({ planMode: !planMode })} disabled={!chat || Boolean(ops.unavailable)} />
          <TodoChip todos={todos} />
          <div className="flex-1" />
          <ContextMeter usage={contextUsage} />
          {running ? (
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
            disabled={sending || Boolean(ops.unavailable) || (!draft.trim() && attachments.length === 0)}
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
