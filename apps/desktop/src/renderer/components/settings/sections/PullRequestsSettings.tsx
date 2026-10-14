import { useEffect, useState } from 'react';
import {
  defaultFleetModelForAgent,
  storedFleetModelForAgent,
  isStoredFleetModelId,
  fleetAgentForModel,
  parseAutoKeepMergeableLabels,
  type FleetAgent,
  type Workspace,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { toast } from '../../../stores/toast';
import { maybeHandleBillingLimit } from '../../../stores/billing';
import { useWorkspaceStore } from '../../../stores/workspace';
import { getMergeBlockedNotifyEnabled, setMergeBlockedNotifyEnabled } from '../../../hooks/useApi';
import { Input } from '../../ui/input';
import {
  SettingRow,
  SettingToggle,
  SettingsPage,
  SettingsSection,
  SettingsSelect,
} from '../../ui/settings';

export function PullRequestsSettings() {
  return (
    <SettingsPage title="Pull requests" description="How cloud agents work on this workspace's pull requests">
      <SettingsSection title="Fix runs">
        <AutoKeepMergeableDefaultToggle />
        <AutoKeepMergeableLabelsField />
        <RespondToHumanCommentsToggle />
      </SettingsSection>
      <SettingsSection title="Tasks">
        <CloudProviderDefaultSelector />
      </SettingsSection>
      <SettingsSection title="Notifications">
        <MergeBlockedNotifyToggle />
      </SettingsSection>
    </SettingsPage>
  );
}

/**
 * Workspace default: auto-arm "auto-keep mergeable" on every new PR the viewer
 * authored. Persists to `workspace.settings.defaultAutoKeepMergeable`; the
 * backend applies it only to authored PRs on first sighting (never a PR you're
 * only reviewing). Individual PRs stay hand-toggleable in the PR detail sheet.
 *
 * Turning it ON is an Unlimited feature — the backend 402s an OFF→ON change on
 * a free plan and the upgrade modal opens. A workspace that already has it on
 * is grandfathered and can keep it (but not re-enable it after turning it off).
 * The same toggle, more prominently, lives in the My PRs header.
 */
export function AutoKeepMergeableDefaultToggle() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const [saving, setSaving] = useState(false);

  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const enabled = workspace?.settings?.defaultAutoKeepMergeable === true;

  const onToggle = async (next: boolean) => {
    if (!currentWorkspaceId) return;
    setSaving(true);
    try {
      const settings = { defaultAutoKeepMergeable: next } as Workspace['settings'];
      await api.workspaces.update(currentWorkspaceId, { settings });
      setWorkspaces(
        workspaces.map((w) =>
          w.id === currentWorkspaceId
            ? { ...w, settings: { ...w.settings, ...settings } as Workspace['settings'] }
            : w,
        ),
      );
    } catch (err) {
      // Turning it on needs Unlimited — surface the upgrade flow rather than
      // letting the 402 reject unhandled and leave the checkbox looking stuck.
      if (!maybeHandleBillingLimit(err, 'auto_keep_default_settings')) {
        toast.error(
          'Could not change the auto-keep setting',
          err instanceof Error ? err.message : undefined,
        );
      }
    } finally {
      setSaving(false);
    }
  };


  return (
    <SettingToggle
      checked={enabled}
      disabled={saving || !currentWorkspaceId}
      onChange={(next) => void onToggle(next)}
      label="Auto-keep new PRs mergeable"
      description={
        <>
          When a PR you authored first shows up in this workspace, automatically turn on
          “Auto-keep mergeable” — a cloud agent fixes conflicts, CI, and review comments to keep
          it mergeable until it merges. Applies only to PRs you opened, never ones you’re just
          reviewing. You can still toggle any individual PR from its detail panel.
        </>
      }
    />
  );
}

/**
 * Workspace-wide: may a fix run reply to, resolve, or push code for review
 * threads a HUMAN opened?
 *
 * Asked for by reviewers on PostHog/posthog — an agent replying on their review
 * threads is noise on a conversation between people, and resolving one closes a
 * thread its author had not finished with. Bot threads are unaffected either
 * way; they are the ones nobody wants to triage by hand.
 *
 * Absent means on, so existing workspaces keep today's behaviour rather than
 * being silently muted. Applies to every fix run — auto-keep, the merge queue,
 * and the manual "Get PR mergeable" button.
 */
export function RespondToHumanCommentsToggle() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const [saving, setSaving] = useState(false);

  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const enabled = workspace?.settings?.respondToHumanComments !== false;

  const onToggle = async (next: boolean) => {
    if (!currentWorkspaceId) return;
    setSaving(true);
    try {
      const settings = { respondToHumanComments: next } as Workspace['settings'];
      await api.workspaces.update(currentWorkspaceId, { settings });
      setWorkspaces(
        workspaces.map((w) =>
          w.id === currentWorkspaceId
            ? { ...w, settings: { ...w.settings, ...settings } as Workspace['settings'] }
            : w,
        ),
      );
    } catch (err) {
      toast.error(
        'Could not change the review-comment setting',
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setSaving(false);
    }
  };


  return (
    <label className="flex cursor-pointer items-start gap-3 px-3 py-2 text-[13px]">
      <input
        type="checkbox"
        checked={enabled}
        disabled={saving || !currentWorkspaceId}
        onChange={(e) => void onToggle(e.target.checked)}
        className="mt-0.5"
        data-attr="settings-respond-to-human-comments"
      />
      <div className="min-w-0 flex-1">
        <div>Reply to human review comments</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          When on, a fix run treats a human reviewer&rsquo;s comments like a bot&rsquo;s: it
          implements them, replies on the thread, and resolves it. Turn it off and human threads
          are left completely alone — read for context, never replied to, resolved, or acted on —
          so the conversation stays between people. Comments from bots and automated reviewers
          are handled either way.
        </p>
      </div>
    </label>
  );
}

/** Persists to `workspace.settings.autoKeepMergeableLabels`; the watcher tick applies them and never removes them. */
export function AutoKeepMergeableLabelsField() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const [saving, setSaving] = useState(false);

  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const saved = (workspace?.settings?.autoKeepMergeableLabels ?? []).join(', ');
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved, currentWorkspaceId]);

  const commit = async () => {
    const labels = parseAutoKeepMergeableLabels(draft);
    if (!currentWorkspaceId || labels.join(', ') === saved) {
      setDraft(saved);
      return;
    }
    setSaving(true);
    try {
      const settings = { autoKeepMergeableLabels: labels } as Workspace['settings'];
      await api.workspaces.update(currentWorkspaceId, { settings });
      setWorkspaces(
        workspaces.map((w) =>
          w.id === currentWorkspaceId
            ? { ...w, settings: { ...w.settings, ...settings } as Workspace['settings'] }
            : w,
        ),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save labels');
      setDraft(saved);
    } finally {
      setSaving(false);
    }
  };


  return (
    <div className="space-y-2 px-3 py-2 text-[13px]">
      <div>
        <div>Label watched PRs</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Add these GitHub labels to every PR that “Auto-keep mergeable” is watching, so a bot in
          your org that keys off a label (auto-review, stamping) picks them up. Comma-separated.
          Applied within a minute, including to PRs already being watched, and never removed. Leave
          blank to turn off. Needs the GitHub App’s “Issues: Read &amp; write” permission.
        </p>
      </div>
      <Input
        placeholder="e.g. auto-review, needs-stamp"
        value={draft}
        disabled={saving || !currentWorkspaceId}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        className="max-w-sm"
      />
    </div>
  );
}

/**
 * Which agent new tasks go to by default.
 *
 * # Why the options are AGENTS, not providers
 *
 * "Talyn Fleet" does not say enough. The fleet runs on the workspace's own
 * Claude subscription or its own Codex subscription, and which one is decided
 * by the MODEL — `fleetProviderForModel` reads it, and the fleet builds the
 * microVM's egress route table from that. So a list of providers left the most
 * consequential half of the choice somewhere else entirely (the Model picker,
 * now in Settings → Sessions), where nobody looking at "Default for new tasks" would
 * think to go.
 *
 * The options are therefore one per connected AGENT. Picking one writes both
 * halves: `defaultCloudProvider` and, for a fleet agent, `fleetModel`.
 *
 * # The model is only rewritten when the VENDOR changes
 *
 * A workspace that deliberately pinned Opus 5 must not be moved to Sonnet 5
 * just for re-picking "Claude" here — that is a real cost difference nobody
 * asked for. So the model is left alone when the current one already belongs to
 * the chosen agent, and swapped to that agent's default only when the choice
 * actually crosses vendors.
 */
export function CloudProviderDefaultSelector() {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  // One source of truth — preloaded + kept fresh by useSystemStatus.
  const cloudProviders = useWorkspaceStore((s) => s.cloudProviders);
  const connected = (cloudProviders ?? []).filter((p) => p.connected);
  const [saving, setSaving] = useState(false);

  const workspace = workspaces.find((w) => w.id === currentWorkspaceId);
  const settings = workspace?.settings;
  const provider = (settings?.defaultCloudProvider as string | undefined) ?? '';
  const fleetModel = settings?.fleetModel;

  // One entry per thing a task can actually be sent to. The fleet contributes
  // one per connected subscription; every other provider contributes itself.
  const options = connected.flatMap((p) => {
    if (p.type !== 'selfhosted') {
      return [{ value: p.type, label: p.displayName }];
    }
    const agents = (p.connectedAgents ?? []) as FleetAgent[];
    return agents.map((agent) => ({
      value: `selfhosted:${agent}`,
      label: `${p.displayName} · ${agent === 'codex' ? 'Codex' : 'Claude'}`,
    }));
  });

  // A fleet default reads back as whichever agent its model belongs to, so the
  // control and the Model picker on the card can never disagree.
  const current =
    provider === 'selfhosted' ? `selfhosted:${fleetAgentForModel(fleetModel)}` : provider;

  const onChange = async (value: string) => {
    if (!currentWorkspaceId) return;
    setSaving(true);
    try {
      const [type, agent] = value.split(':');
      const defaultCloudProvider = type === '' ? undefined : type;

      const patch: Partial<NonNullable<Workspace['settings']>> = { defaultCloudProvider } as never;
      if (agent) {
        // Only when the choice crosses vendors — see the note above on Opus 5.
        const leaving = fleetAgentForModel(fleetModel);
        const keepsVendor = leaving === agent;
        if (!keepsVendor) {
          // Remember the model we are LEAVING before overwriting it, and
          // restore whatever this vendor was last set to. `fleetModel` holds
          // one model for one vendor, so switching used to overwrite the other
          // vendor's choice with the shipped default — flip to Claude and back
          // and your Codex model was silently gone.
          patch.fleetModels = {
            ...(settings?.fleetModels ?? {}),
            ...(isStoredFleetModelId(fleetModel) ? { [leaving]: fleetModel } : {}),
          };
          patch.fleetModel =
            storedFleetModelForAgent(settings, agent as FleetAgent) ??
            defaultFleetModelForAgent(agent as FleetAgent);
        }
      }

      await api.workspaces.update(currentWorkspaceId, {
        settings: patch as Workspace['settings'],
      });
      setWorkspaces(
        workspaces.map((w) =>
          w.id === currentWorkspaceId
            ? { ...w, settings: { ...w.settings, ...patch } as Workspace['settings'] }
            : w
        )
      );
    } finally {
      setSaving(false);
    }
  };


  return (
    <SettingRow
      label="Default for new tasks"
      description={
        <>
          Which agent new tasks run on. Auto prefers Talyn Fleet, then PostHog Code.
          “Ask every time” shows a picker on the Task button when more than one is connected.
        </>
      }
    >
      <SettingsSelect
        value={current}
        disabled={saving}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Auto</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        <option value="ask">Ask every time</option>
      </SettingsSelect>
    </SettingRow>
  );
}

/** Per device, in localStorage; `notifyMergeQueueBlocked` in useApi reads it. */
function MergeBlockedNotifyToggle() {
  const [notifyBlocked, setNotifyBlocked] = useState(getMergeBlockedNotifyEnabled());
  const [notifyPermission, setNotifyPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied'
  );

  const toggleNotifyBlocked = async (next: boolean) => {
    setMergeBlockedNotifyEnabled(next);
    setNotifyBlocked(next);
    // Request OS permission eagerly on enable so the first real block doesn't
    // race the browser permission prompt.
    if (next && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        setNotifyPermission(await Notification.requestPermission());
      } catch {
        // ignore
      }
    }
  };

  return (
    <SettingToggle
      checked={notifyBlocked}
      onChange={(next) => void toggleNotifyBlocked(next)}
      label="Notify me when a merge-queue PR is blocked"
      description={
        <>
          Shows a desktop notification and an in-app alert when a PR in the merge
          queue gives up after its retry budget and needs manual intervention.
          Click the notification to jump to it.
          {notifyPermission === 'denied' && (
            <span className="mt-1 block text-yellow-500">
              Desktop notifications are blocked at the OS level — grant Talyn
              permission in your system settings to receive them. (The in-app alert
              still shows.)
            </span>
          )}
        </>
      }
    />
  );
}
