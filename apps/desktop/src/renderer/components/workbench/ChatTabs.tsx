import { useMemo, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { formatKeys } from '../../lib/shortcuts';
import { api } from '../../lib/api';
import { toast } from '../../stores/toast';
import { useWorkbenchStore, visibleChats } from '../../stores/workbenches';
import { StatusDot } from './WorkbenchBadges';

/** Make a new chat tab and open it. Shared with the composer's first send. */
export async function createChatTab(workbench: Workbench): Promise<WorkbenchChat | null> {
  try {
    const chat = await api.workbenches.createChat(workbench.id, {});
    const store = useWorkbenchStore.getState();
    store.upsertChat(chat);
    store.setChatEventsState(chat.id, { loaded: true });
    store.selectChat(workbench.id, chat.id);
    return chat;
  } catch (err) {
    toast.error('Could not open a new chat', err instanceof Error ? err.message : undefined);
    return null;
  }
}

export function ChatTabs({ workbench, selected }: { workbench: Workbench; selected: WorkbenchChat | null }) {
  const allChats = useWorkbenchStore((s) => s.chats);
  const hiddenChatIds = useWorkbenchStore((s) => s.hiddenChatIds);
  const chats = useMemo(
    () => visibleChats({ chats: allChats, hiddenChatIds }, workbench.id),
    [allChats, hiddenChatIds, workbench.id]
  );
  const unread = useWorkbenchStore((s) => s.unread);
  const selectChat = useWorkbenchStore((s) => s.selectChat);
  const hideChat = useWorkbenchStore((s) => s.hideChat);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [title, setTitle] = useState('');

  const newChat = async () => {
    setCreating(true);
    await createChatTab(workbench);
    setCreating(false);
  };

  const commitRename = async (chat: WorkbenchChat) => {
    setRenaming(null);
    const next = title.trim();
    if (!next || next === chat.title) return;
    try {
      useWorkbenchStore.getState().upsertChat(await api.workbenches.updateChat(chat.id, { title: next }));
    } catch (err) {
      toast.error('Could not rename the chat', err instanceof Error ? err.message : undefined);
    }
  };

  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-2" role="tablist" aria-label="Chats">
      {chats.map((chat) => {
        const active = chat.id === selected?.id;
        const tone = chat.status === 'running' ? 'running' : chat.status === 'error' ? 'error' : unread[chat.id] ? 'unread' : null;
        return (
          <div
            key={chat.id}
            role="tab"
            aria-selected={active}
            className={cn(
              'group flex max-w-[14rem] shrink-0 items-center gap-1.5 border-b-2 px-2 py-1.5 text-xs',
              active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {tone && <StatusDot tone={tone} />}
            {renaming === chat.id ? (
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => void commitRename(chat)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename(chat);
                  if (e.key === 'Escape') setRenaming(null);
                }}
                className="w-32 rounded border bg-background px-1 text-xs outline-none"
                aria-label="Chat title"
              />
            ) : (
              <button
                type="button"
                className="truncate"
                onClick={() => selectChat(workbench.id, chat.id)}
                onDoubleClick={() => {
                  setTitle(chat.title);
                  setRenaming(chat.id);
                }}
                title="Double-click to rename"
              >
                {chat.title || 'Chat'}
              </button>
            )}
            <button
              type="button"
              onClick={() => hideChat(workbench.id, chat.id)}
              className="rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100"
              title="Close this tab (⌘W)"
              aria-label={`Close ${chat.title || 'chat'}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => void newChat()}
        disabled={creating}
        className="ml-1 shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        title={`New chat (${formatKeys('mod+t')})`}
        aria-label="New chat"
      >
        {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
