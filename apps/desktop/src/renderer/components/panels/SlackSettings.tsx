// Settings → Slack: install the Talyn app in a Slack workspace, link your Slack
// account, and pick the emojis that start a session. Talyn never posts in
// Slack; it shows progress with reactions.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Copy, Ellipsis, Loader2, Plus, Search, Slack, X } from 'lucide-react';
import {
  SLACK_NOT_CONFIGURED_CODE,
  SLACK_UNAVAILABLE_CODE,
  type SlackInstallationView,
  type SlackStatus,
  type SlackUserLinkView,
} from '@talyn/shared';
import { api } from '../../lib/api';
import { openExternal } from '../../lib/openExternal';
import { toast } from '../../stores/toast';
import { useWorkspaceStore } from '../../stores/workspace';
import { cn } from '../../lib/utils';
import {
  loadStandardEmoji,
  searchEmoji,
  type StandardEmojiIndex,
} from '../../lib/slackEmoji';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Select } from '../ui/select';

function errorCode(e: unknown): string | undefined {
  return (e as { code?: string } | null)?.code;
}

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** One Slack team: its installation, the caller's link, or both. */
interface TeamEntry {
  teamId: string;
  installation: SlackInstallationView | null;
  link: SlackUserLinkView | null;
}

function mergeTeams(status: SlackStatus): TeamEntry[] {
  const teams: TeamEntry[] = status.installations.map((installation) => ({
    teamId: installation.teamId,
    installation,
    link: status.links.find((l) => l.teamId === installation.teamId) ?? null,
  }));
  for (const link of status.links) {
    if (!teams.some((t) => t.teamId === link.teamId)) {
      teams.push({ teamId: link.teamId, installation: null, link });
    }
  }
  return teams;
}

/** How many results the picker draws. Typing narrows the rest. */
const PICKER_LIMIT = 120;
const PICKER_COLUMNS = 8;

interface CustomEmoji {
  name: string;
  url: string;
}

function EmojiVisual({
  name,
  index,
  custom,
}: {
  name: string;
  index: StandardEmojiIndex | null;
  custom: CustomEmoji[];
}) {
  // A workspace emoji wins over a standard one of the same name, as in Slack.
  const url = custom.find((c) => c.name === name)?.url;
  if (url) return <img src={url} alt={`:${name}:`} className="h-4 w-4 object-contain" />;
  const glyph = index?.glyphs.get(name);
  if (glyph) {
    return (
      <span role="img" aria-label={name} className="text-base leading-none">
        {glyph}
      </span>
    );
  }
  return <span className="inline-block h-4 w-4 rounded-full bg-muted" aria-hidden="true" />;
}

function EmojiPicker({
  index,
  custom,
  taken,
  onPick,
}: {
  index: StandardEmojiIndex | null;
  custom: CustomEmoji[];
  taken: string[];
  onPick: (name: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const results = useMemo(
    () =>
      searchEmoji(index, custom, query)
        .filter((e) => !e.aliases.some((a) => taken.includes(a)))
        .slice(0, PICKER_LIMIT),
    [index, custom, query, taken]
  );
  const current = results[Math.min(active, results.length - 1)];

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    document.getElementById(`slack-emoji-opt-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  function onKeyDown(e: React.KeyboardEvent) {
    const step: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: PICKER_COLUMNS,
      ArrowUp: -PICKER_COLUMNS,
    };
    if (e.key in step) {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(results.length - 1, a + step[e.key])));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (current) onPick(current.name);
    }
  }

  return (
    <div className="space-y-2" data-attr="settings-slack-emoji-picker">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
        <Input
          autoFocus
          aria-label="Search emoji"
          aria-controls="slack-emoji-grid"
          aria-activedescendant={current ? `slack-emoji-opt-${active}` : undefined}
          placeholder="Search emoji"
          className="pl-8"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      {!index ? (
        <p className="px-1 py-4 text-center text-xs text-muted-foreground">Loading emoji…</p>
      ) : results.length === 0 ? (
        <p className="px-1 py-4 text-center text-xs text-muted-foreground">No emoji found.</p>
      ) : (
        <div
          id="slack-emoji-grid"
          role="listbox"
          aria-label="Emoji"
          className="grid max-h-56 grid-cols-8 gap-0.5 overflow-y-auto"
        >
          {results.map((e, i) => (
            <button
              key={e.name}
              id={`slack-emoji-opt-${i}`}
              type="button"
              role="option"
              aria-selected={i === active}
              aria-label={e.name}
              title={`:${e.name}:`}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded text-lg hover:bg-accent',
                i === active && 'bg-accent'
              )}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(e.name)}
            >
              {e.url ? (
                <img src={e.url} alt="" className="h-5 w-5 object-contain" />
              ) : (
                <span aria-hidden="true">{e.glyph}</span>
              )}
            </button>
          ))}
        </div>
      )}
      <p className="h-4 truncate px-1 text-xs text-muted-foreground">
        {current ? `:${current.name}:  ${current.label !== current.name ? current.label : ''}` : ''}
      </p>
    </div>
  );
}

function TriggerEmojiRow({
  link,
  teamId,
  onReconnect,
}: {
  link: SlackUserLinkView;
  teamId: string;
  onReconnect: () => void;
}) {
  const [emojis, setEmojis] = useState<string[]>(link.triggerEmojis);
  const [index, setIndex] = useState<StandardEmojiIndex | null>(null);
  const [custom, setCustom] = useState<CustomEmoji[]>([]);
  const [needsScope, setNeedsScope] = useState(false);
  const [open, setOpen] = useState(false);
  const saveSeq = useRef(0);

  useEffect(() => {
    let live = true;
    loadStandardEmoji()
      .then((i) => live && setIndex(i))
      .catch(() => undefined);
    api.slack
      .listEmoji(teamId)
      .then((r) => {
        if (!live) return;
        setCustom(r.emoji);
        setNeedsScope(r.needsScope === 'emoji:read');
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [teamId]);

  async function persist(next: string[]) {
    const previous = emojis;
    const seq = ++saveSeq.current;
    setEmojis(next);
    try {
      await api.slack.updateLink(link.id, { triggerEmojis: next });
    } catch (e) {
      if (seq === saveSeq.current) setEmojis(previous);
      toast.error('Could not save trigger emojis', errorMessage(e, 'Try again.'));
    }
  }

  return (
    <div className="space-y-2" data-attr="settings-slack-emoji-row">
      <div className="flex items-start gap-3">
        <span className="w-28 shrink-0 pt-1.5 text-sm text-muted-foreground">Trigger emoji</span>
        <div className="flex flex-wrap items-center gap-2" data-attr="settings-slack-emoji-list">
          {emojis.map((name) => (
            <span
              key={name}
              data-attr="settings-slack-emoji-chip"
              className="group inline-flex items-center gap-1.5 rounded-full border bg-secondary/60 py-1 pl-2 pr-1.5 text-sm"
            >
              <EmojiVisual name={name} index={index} custom={custom} />
              <span className="text-xs text-muted-foreground">:{name}:</span>
              <button
                type="button"
                aria-label={`Remove :${name}:`}
                className="rounded-full p-0.5 text-muted-foreground opacity-0 hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                onClick={() => void persist(emojis.filter((n) => n !== name))}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                data-attr="settings-slack-emoji-add"
                className="inline-flex items-center gap-1 rounded-full border border-dashed px-2.5 py-1 text-sm text-muted-foreground hover:border-solid hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                Add emoji
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 p-2">
              <EmojiPicker
                index={index}
                custom={custom}
                taken={emojis}
                onPick={(name) => {
                  setOpen(false);
                  void persist([...emojis, name]);
                }}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {emojis.length === 0 && (
        <p className="pl-[7.75rem] text-xs text-muted-foreground">
          No emoji. Reactions will not start a session.
        </p>
      )}
      {needsScope && (
        <p
          className="flex flex-wrap items-center gap-2 pl-[7.75rem] text-xs text-muted-foreground"
          data-attr="settings-slack-emoji-needs-scope"
        >
          Reconnect Slack to show your workspace&apos;s custom emoji.
          <button
            type="button"
            data-attr="settings-slack-emoji-reconnect"
            className="underline hover:text-foreground"
            onClick={onReconnect}
          >
            Reconnect
          </button>
        </p>
      )}
    </div>
  );
}

function TargetWorkspaceRow({
  link,
  workspaces,
}: {
  link: SlackUserLinkView;
  workspaces: { id: string; name: string }[];
}) {
  const [value, setValue] = useState(link.workspaceId ?? workspaces[0]?.id ?? '');
  const [state, setState] = useState<SaveState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failed = useRef('');
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  async function save(next: string, previous: string) {
    setValue(next);
    setState('saving');
    try {
      await api.slack.updateLink(link.id, { workspaceId: next });
      setState('saved');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), 2000);
    } catch {
      setValue(previous);
      setState('error');
      failed.current = next;
    }
  }

  return (
    <div className="flex items-center gap-3" data-attr="settings-slack-target-row">
      <label className="w-28 shrink-0 text-sm text-muted-foreground" htmlFor={`slack-ws-${link.id}`}>
        Sessions go to
      </label>
      <div className="w-56">
        <Select
          id={`slack-ws-${link.id}`}
          aria-label="Target workspace"
          value={value}
          disabled={state === 'saving'}
          onChange={(e) => void save(e.target.value, value)}
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
      </div>
      {state === 'saving' && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      {state === 'saved' && (
        <span
          className="inline-flex items-center gap-1 text-xs text-green-500"
          data-attr="settings-slack-target-saved"
        >
          <Check className="h-3.5 w-3.5" />
          Saved
        </span>
      )}
      {state === 'error' && (
        <span className="inline-flex items-center gap-2 text-xs text-destructive">
          Could not save.
          <button
            type="button"
            data-attr="settings-slack-target-retry"
            className="underline"
            onClick={() => void save(failed.current, value)}
          >
            Retry
          </button>
        </span>
      )}
    </div>
  );
}

function InviteHint({ botName }: { botName: string | null }) {
  const [copied, setCopied] = useState(false);
  const command = `/invite @${botName ?? 'talyn'}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy', 'Select the command and copy it by hand.');
    }
  }

  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      Add Talyn to a channel:
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{command}</code>
      <button
        type="button"
        aria-label="Copy invite command"
        data-attr="settings-slack-invite-copy"
        className="rounded p-1 hover:text-foreground"
        onClick={() => void copy()}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </p>
  );
}

function TeamCard({
  team,
  workspaces,
  busy,
  onStart,
  onChanged,
}: {
  team: TeamEntry;
  workspaces: { id: string; name: string }[];
  busy: 'install' | 'link' | null;
  onStart: (kind: 'install' | 'link') => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const { installation, link } = team;
  const [confirm, setConfirm] = useState<'unlink' | 'disconnect' | null>(null);
  const [working, setWorking] = useState(false);

  const name = installation?.teamName ?? link?.teamName ?? team.teamId;
  const broken = installation ? installation.needsReinstall : true;
  const pill = !installation ? (
    <Badge variant="warning">App removed</Badge>
  ) : installation.needsReinstall ? (
    <Badge variant="warning">Needs reconnect</Badge>
  ) : !link ? (
    <Badge variant="secondary">Not linked</Badge>
  ) : (
    <Badge variant="success">Connected</Badge>
  );

  async function unlink() {
    if (!link) return;
    setWorking(true);
    try {
      await api.slack.unlink(link.id);
      toast.success('Slack account unlinked');
      setConfirm(null);
      await onChanged();
    } catch (e) {
      toast.error('Could not unlink', errorMessage(e, 'Try again.'));
    } finally {
      setWorking(false);
    }
  }

  async function disconnect() {
    setWorking(true);
    try {
      const res = await api.slack.forgetInstallation(team.teamId);
      toast.success('Slack workspace disconnected', res.message);
      setConfirm(null);
      await onChanged();
    } catch (e) {
      toast.error('Could not disconnect', errorMessage(e, 'Try again.'));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Card className="space-y-4 p-4" data-attr="settings-slack-team-card" data-team-id={team.teamId}>
      <div className="flex items-center gap-2">
        <Slack className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">{name}</span>
        {pill}
        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Actions for ${name}`}
                data-attr="settings-slack-menu"
              >
                <Ellipsis className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                data-attr="settings-slack-menu-reconnect"
                disabled={busy !== null}
                onSelect={() => void onStart('install')}
              >
                Reconnect
              </DropdownMenuItem>
              {link && (
                <DropdownMenuItem
                  className="text-destructive"
                  data-attr="settings-slack-menu-unlink"
                  onSelect={() => setConfirm('unlink')}
                >
                  Unlink my account
                </DropdownMenuItem>
              )}
              {installation?.installedByMe && (
                <DropdownMenuItem
                  className="text-destructive"
                  data-attr="settings-slack-menu-disconnect"
                  onSelect={() => setConfirm('disconnect')}
                >
                  Disconnect workspace
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {broken && (
        <div className="space-y-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3">
          <p className="flex items-center gap-2 text-sm">
            <AlertCircle className="h-4 w-4 text-yellow-500" />
            {installation
              ? "Slack stopped accepting Talyn's access. Reconnect to start sessions again."
              : 'The Talyn app is no longer installed in this Slack workspace.'}
          </p>
          <Button
            size="sm"
            data-attr="settings-slack-reconnect"
            disabled={busy !== null}
            onClick={() => void onStart('install')}
          >
            Reconnect
          </Button>
        </div>
      )}

      {installation && !installation.needsReinstall && !link && (
        <Button
          size="sm"
          data-attr="settings-slack-link"
          disabled={busy !== null}
          onClick={() => void onStart('link')}
        >
          {busy === 'link' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Link my Slack account
        </Button>
      )}

      {link && (
        <div className="space-y-3">
          <TargetWorkspaceRow link={link} workspaces={workspaces} />
          <TriggerEmojiRow
            link={link}
            teamId={team.teamId}
            onReconnect={() => void onStart('install')}
          />
          {installation && <InviteHint botName={installation.botName} />}
        </div>
      )}

      {confirm === 'unlink' && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border p-3">
          <span className="text-sm">Unlink your Slack account from {name}?</span>
          <Button
            size="sm"
            variant="destructive"
            data-attr="settings-slack-unlink-confirm"
            disabled={working}
            onClick={() => void unlink()}
          >
            {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Unlink
          </Button>
          <Button size="sm" variant="ghost" disabled={working} onClick={() => setConfirm(null)}>
            Cancel
          </Button>
        </div>
      )}

      {confirm === 'disconnect' && (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm text-muted-foreground">
            This makes Talyn forget its access token. The app stays installed in Slack until you
            remove it there.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              data-attr="settings-slack-disconnect-confirm"
              disabled={working}
              onClick={() => void disconnect()}
            >
              {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Disconnect
            </Button>
            <Button size="sm" variant="ghost" disabled={working} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export function SlackSettings() {
  const offered = useWorkspaceStore((s) => s.features?.workbenches === true);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);

  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState<string | null>(null);
  const [busy, setBusy] = useState<'install' | 'link' | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.slack.getStatus());
      setLoadError(null);
      setNotConfigured(null);
    } catch (e) {
      if (errorCode(e) === SLACK_NOT_CONFIGURED_CODE) {
        setNotConfigured(errorMessage(e, 'Slack is not set up on this deployment.'));
      } else if (errorCode(e) !== SLACK_UNAVAILABLE_CODE) {
        setLoadError(errorMessage(e, 'Could not load Slack settings.'));
      }
    }
  }, []);

  useEffect(() => {
    if (!offered) return;
    void refresh();
  }, [offered, refresh]);

  // The browser flow ends on a "close this tab" page, so re-read on return.
  useEffect(() => {
    if (!offered) return;
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [offered, refresh]);

  if (!offered) return null;

  async function start(kind: 'install' | 'link') {
    setBusy(kind);
    try {
      const input = currentWorkspaceId ? { workspaceId: currentWorkspaceId } : {};
      const { authorizeUrl } =
        kind === 'install' ? await api.slack.install(input) : await api.slack.link(input);
      await openExternal(authorizeUrl);
    } catch (e) {
      if (errorCode(e) === SLACK_NOT_CONFIGURED_CODE) {
        setNotConfigured(errorMessage(e, 'Slack is not set up on this deployment.'));
      } else {
        toast.error('Could not start Slack sign-in', errorMessage(e, 'Try again.'));
      }
    } finally {
      setBusy(null);
    }
  }

  const header = (
    <div>
      <h3 className="text-lg font-medium">Slack</h3>
      <p className="text-sm text-muted-foreground">
        Start Talyn sessions from Slack: react with your emoji, mention @Talyn, or DM the bot.
        Talyn never posts in Slack; it shows progress with reactions.
      </p>
    </div>
  );

  if (notConfigured) {
    return (
      <div className="space-y-4">
        {header}
        <Card className="p-4" data-attr="settings-slack-not-configured">
          <p className="text-sm text-muted-foreground">{notConfigured}</p>
        </Card>
      </div>
    );
  }

  if (loadError && !status) {
    return (
      <div className="space-y-4">
        {header}
        <Card className="p-4 space-y-3">
          <p className="text-sm text-destructive flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            {loadError}
          </p>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            Try again
          </Button>
        </Card>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="space-y-4">
        {header}
        <Card className="p-4">
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        </Card>
      </div>
    );
  }

  const { installations } = status;
  const teams = mergeTeams(status);

  return (
    <div className="space-y-4">
      {header}

      {installations.length === 0 && (
        <Card className="p-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Talyn is not installed in any Slack workspace yet.
          </p>
          <Button
            size="sm"
            data-attr="settings-slack-connect"
            disabled={busy !== null}
            onClick={() => void start('install')}
          >
            {busy === 'install' && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Connect Slack
          </Button>
        </Card>
      )}

      {teams.map((team) => (
        <TeamCard
          key={team.teamId}
          team={team}
          workspaces={workspaces}
          busy={busy}
          onStart={start}
          onChanged={refresh}
        />
      ))}

      {installations.length > 0 && (
        <button
          type="button"
          data-attr="settings-slack-add-workspace"
          disabled={busy !== null}
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50"
          onClick={() => void start('install')}
        >
          Add another Slack workspace
        </button>
      )}
    </div>
  );
}
