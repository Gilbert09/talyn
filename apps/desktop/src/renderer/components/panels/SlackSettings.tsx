// Settings → Slack: install the Talyn app in a Slack workspace, link your Slack
// account, and pick the emojis that start a session. Talyn never posts in
// Slack; it shows progress with reactions.

import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, Plus, X } from 'lucide-react';
import {
  normalizeSlackEmojiName,
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
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import { Select } from '../ui/select';

function errorCode(e: unknown): string | undefined {
  return (e as { code?: string } | null)?.code;
}

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** Why the emoji draft cannot take this input, or null when it can. */
export function emojiInputError(raw: string, current: string[]): string | null {
  if (!raw.trim()) return null;
  const name = normalizeSlackEmojiName(raw);
  if (!name) return 'Use lowercase letters, digits, _ + or - (for example robot_face).';
  if (current.includes(name)) return `:${name}: is already in the list.`;
  return null;
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

  const { installations, links } = status;
  const linkedTeams = new Set(links.map((l) => l.teamId));

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

      {installations.map((inst) => (
        <InstallationCard
          key={inst.teamId}
          installation={inst}
          linked={linkedTeams.has(inst.teamId)}
          busy={busy}
          onStart={start}
          onChanged={refresh}
        />
      ))}

      {links.map((link) => (
        <LinkCard
          key={link.id}
          link={link}
          botName={installations.find((i) => i.teamId === link.teamId)?.botName ?? null}
          workspaces={workspaces}
          onChanged={refresh}
        />
      ))}

      {installations.length > 0 && (
        <div>
          <Button
            size="sm"
            variant="outline"
            data-attr="settings-slack-add-workspace"
            disabled={busy !== null}
            onClick={() => void start('install')}
          >
            Add another Slack workspace
          </Button>
        </div>
      )}
    </div>
  );
}

function InstallationCard({
  installation,
  linked,
  busy,
  onStart,
  onChanged,
}: {
  installation: SlackInstallationView;
  linked: boolean;
  busy: 'install' | 'link' | null;
  onStart: (kind: 'install' | 'link') => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);

  async function forget() {
    setWorking(true);
    try {
      const res = await api.slack.forgetInstallation(installation.teamId);
      toast.success('Slack workspace disconnected', res.message);
      setConfirming(false);
      await onChanged();
    } catch (e) {
      toast.error('Could not disconnect', errorMessage(e, 'Try again.'));
    } finally {
      setWorking(false);
    }
  }

  const name = installation.teamName ?? installation.teamId;

  return (
    <Card className="p-4 space-y-3" data-attr="settings-slack-installation">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium">{name}</span>
        {installation.installedByMe && <Badge variant="secondary">Installed by you</Badge>}
      </div>

      {installation.needsReinstall && (
        <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 space-y-2">
          <p className="text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-yellow-500" />
            Slack stopped accepting Talyn&apos;s access. Reconnect to start sessions again.
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

      {!linked && !installation.needsReinstall && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Link your Slack account so Talyn knows which sessions are yours.
          </p>
          <Button
            size="sm"
            data-attr="settings-slack-link"
            disabled={busy !== null}
            onClick={() => void onStart('link')}
          >
            {busy === 'link' && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Link my Slack account
          </Button>
        </div>
      )}

      {installation.installedByMe &&
        (confirming ? (
          <div className="space-y-2">
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
                onClick={() => void forget()}
              >
                {working && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Disconnect
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={working}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            data-attr="settings-slack-disconnect"
            onClick={() => setConfirming(true)}
          >
            Disconnect workspace
          </Button>
        ))}
    </Card>
  );
}

function LinkCard({
  link,
  botName,
  workspaces,
  onChanged,
}: {
  link: SlackUserLinkView;
  botName: string | null;
  workspaces: { id: string; name: string }[];
  onChanged: () => Promise<void>;
}) {
  const [emojis, setEmojis] = useState<string[]>(link.triggerEmojis);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  // Take the server's list again after a save or a refresh from elsewhere.
  const serverKey = link.triggerEmojis.join(',');
  useEffect(() => {
    setEmojis(link.triggerEmojis);
  }, [serverKey]);

  const dirty = emojis.join(',') !== serverKey;
  const draftError = emojiInputError(draft, emojis);
  const workspaceValue = link.workspaceId ?? workspaces[0]?.id ?? '';

  function add() {
    if (!draft.trim() || draftError) return;
    const name = normalizeSlackEmojiName(draft);
    if (!name) return;
    setEmojis((prev) => [...prev, name]);
    setDraft('');
  }

  async function saveEmojis() {
    setSaving(true);
    try {
      await api.slack.updateLink(link.id, { triggerEmojis: emojis });
      toast.success('Trigger emojis saved');
      await onChanged();
    } catch (e) {
      toast.error('Could not save emojis', errorMessage(e, 'Try again.'));
    } finally {
      setSaving(false);
    }
  }

  async function changeWorkspace(workspaceId: string) {
    try {
      await api.slack.updateLink(link.id, { workspaceId });
      toast.success('Target workspace saved');
      await onChanged();
    } catch (e) {
      toast.error('Could not change workspace', errorMessage(e, 'Try again.'));
    }
  }

  async function unlink() {
    setUnlinking(true);
    try {
      await api.slack.unlink(link.id);
      toast.success('Slack account unlinked');
      await onChanged();
    } catch (e) {
      toast.error('Could not unlink', errorMessage(e, 'Try again.'));
      setUnlinking(false);
    }
  }

  return (
    <Card className="p-4 space-y-4" data-attr="settings-slack-link-card">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium">{link.teamName ?? link.teamId}</span>
        <Badge variant="secondary">Linked</Badge>
        {!link.installed && <Badge variant="outline">App removed</Badge>}
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium" htmlFor={`slack-ws-${link.id}`}>
          Start sessions in
        </label>
        <Select
          id={`slack-ws-${link.id}`}
          aria-label="Target workspace"
          value={workspaceValue}
          onChange={(e) => void changeWorkspace(e.target.value)}
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor={`slack-emoji-${link.id}`}>
          Trigger emojis
        </label>
        <div className="flex flex-wrap gap-2" data-attr="settings-slack-emoji-list">
          {emojis.length === 0 && (
            <span className="text-sm text-muted-foreground">
              No emojis. Reactions will not start a session.
            </span>
          )}
          {emojis.map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-1 text-sm"
            >
              :{name}:
              <button
                type="button"
                aria-label={`Remove :${name}:`}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setEmojis((prev) => prev.filter((n) => n !== name))}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            id={`slack-emoji-${link.id}`}
            placeholder=":robot_face:"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button
            size="sm"
            variant="outline"
            data-attr="settings-slack-emoji-add"
            disabled={!draft.trim() || draftError !== null}
            onClick={add}
          >
            <Plus className="w-4 h-4 mr-1" />
            Add
          </Button>
        </div>
        {draftError && <p className="text-sm text-destructive">{draftError}</p>}
        <Button
          size="sm"
          data-attr="settings-slack-emoji-save"
          disabled={!dirty || saving}
          onClick={() => void saveEmojis()}
        >
          {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Save emojis
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Invite the bot to a channel with /invite @{botName ?? 'talyn'} so reactions and mentions
        there reach Talyn.
      </p>

      {confirmUnlink ? (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm">Unlink your Slack account?</span>
          <Button
            size="sm"
            variant="destructive"
            data-attr="settings-slack-unlink-confirm"
            disabled={unlinking}
            onClick={() => void unlink()}
          >
            Unlink
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={unlinking}
            onClick={() => setConfirmUnlink(false)}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          data-attr="settings-slack-unlink"
          onClick={() => setConfirmUnlink(true)}
        >
          Unlink
        </Button>
      )}
    </Card>
  );
}
