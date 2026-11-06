import { useEffect, useState } from 'react';
import { Archive, Check, Loader2, Pencil, Plus, Trash2, UserPlus, X } from 'lucide-react';
import {
  MAX_SPACE_NAME_LENGTH,
  MAX_TEAM_NAME_LENGTH,
  TEAM_ROLES,
  canManageTeam,
  type Space,
  type SpacesTeam,
  type TeamMember,
  type TeamRole,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { toast } from '../../../stores/toast';
import { useBillingStore } from '../../../stores/billing';
import { useWorkspaceStore } from '../../../stores/workspace';
import { loadMembers, loadSpaceRepositories, loadTeams, useSpacesStore } from '../../../stores/spaces';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { Input } from '../../ui/input';
import { SettingRow, SettingsPage, SettingsSection } from '../../ui/settings';
import { MemberAvatar, SpaceDot } from '../../spaces/SpaceAvatars';
import { ColorPicker } from '../../spaces/SpaceDialogs';
import { TeamSettings as TeamSeats } from '../../panels/TeamBilling';

const ROLE_LABEL: Record<TeamRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function TeamsSettings() {
  const teams = useSpacesStore((s) => s.teams);
  const selectedId = useSpacesStore((s) => s.settingsTeamId);
  const setSelectedId = useSpacesStore((s) => s.setSettingsTeamId);
  const openDialog = useSpacesStore((s) => s.openDialog);
  const seatsOffered = useWorkspaceStore((s) => s.features?.teams === true);
  const onSeatTeam = useBillingStore((s) => Boolean(s.status?.team));

  useEffect(() => {
    void loadTeams();
  }, []);

  const team = teams?.find((t) => t.id === selectedId) ?? teams?.[0] ?? null;

  if (teams === null) {
    return (
      <SettingsPage title="Teams">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title="Teams"
      description="A team shares spaces. Teammates see each other's sessions in a space. Each person's work runs on their own account."
    >
      {teams.length === 0 ? (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4 text-sm" data-attr="teams-empty">
          <p>Create a team to share sessions with your teammates.</p>
          <Button size="sm" onClick={() => openDialog({ kind: 'createTeam' })}>
            <Plus className="mr-1 h-4 w-4" /> Create team
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {teams.length > 1 &&
              teams.map((t) => (
                <Button
                  key={t.id}
                  size="sm"
                  variant={t.id === team?.id ? 'secondary' : 'ghost'}
                  onClick={() => setSelectedId(t.id)}
                >
                  {t.name}
                </Button>
              ))}
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => openDialog({ kind: 'createTeam' })}>
              <Plus className="mr-1 h-4 w-4" /> Create team
            </Button>
          </div>
          {team && <TeamDetail key={team.id} team={team} />}
        </>
      )}
      {(seatsOffered || onSeatTeam) && (
        <section className="space-y-2" data-attr="teams-seats">
          <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Seats and billing</h2>
          <TeamSeats />
        </section>
      )}
    </SettingsPage>
  );
}

function TeamDetail({ team }: { team: SpacesTeam }) {
  const manage = canManageTeam(team.role);
  return (
    <div className="space-y-6">
      <TeamNameRow team={team} manage={manage} />
      <HomeWorkspaceRow team={team} />
      <MembersSection team={team} manage={manage} />
      <SpacesSection team={team} manage={manage} />
    </div>
  );
}

function TeamNameRow({ team, manage }: { team: SpacesTeam; manage: boolean }) {
  const [name, setName] = useState(team.name);
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(team.name), [team.name]);
  const dirty = name.trim() !== team.name && name.trim().length > 0;
  const save = async () => {
    setBusy(true);
    try {
      const updated = await api.teams.rename(team.id, name.trim());
      if (updated) useSpacesStore.getState().upsertTeam(updated);
    } catch (err) {
      toast.error('Could not rename the team', errorText(err, ''));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection title="Team">
      <SettingRow label="Name" description={`Your role: ${ROLE_LABEL[team.role]}`}>
        {manage ? (
          <>
            <Input
              value={name}
              maxLength={MAX_TEAM_NAME_LENGTH}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && dirty) void save();
              }}
              className="h-8 w-48"
              aria-label="Team name"
            />
            {dirty && (
              <Button size="sm" onClick={() => void save()} disabled={busy}>
                Save
              </Button>
            )}
          </>
        ) : (
          <span className="text-sm">{team.name}</span>
        )}
      </SettingRow>
    </SettingsSection>
  );
}

function HomeWorkspaceRow({ team }: { team: SpacesTeam }) {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const [busy, setBusy] = useState(false);
  const change = async (workspaceId: string) => {
    setBusy(true);
    try {
      const res = await api.teams.setHomeWorkspace(team.id, workspaceId);
      useSpacesStore.getState().upsertTeam({ ...team, homeWorkspaceId: res.homeWorkspaceId });
    } catch (err) {
      toast.error('Could not change the home workspace', errorText(err, ''));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection title="Your home workspace">
      <SettingRow
        label="Runs and pays for your work in this team"
        description="Sessions you start in this team's spaces use this workspace's agents, GitHub and box-hours."
      >
        <select
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          value={team.homeWorkspaceId ?? ''}
          disabled={busy || workspaces.length === 0}
          onChange={(e) => void change(e.target.value)}
          aria-label="Home workspace"
          data-attr="team-home-workspace"
        >
          {!team.homeWorkspaceId && <option value="">None</option>}
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </SettingRow>
    </SettingsSection>
  );
}

function MembersSection({ team, manage }: { team: SpacesTeam; manage: boolean }) {
  const members = useSpacesStore((s) => s.members[team.id]);
  const [login, setLogin] = useState('');
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  useEffect(() => {
    void loadMembers(team.id);
  }, [team.id]);

  const replace = (member: TeamMember) => {
    const current = useSpacesStore.getState().members[team.id] ?? [];
    useSpacesStore.getState().setMembers(team.id, current.some((m) => m.id === member.id)
      ? current.map((m) => (m.id === member.id ? member : m))
      : [...current, member]);
  };

  const invite = async () => {
    const value = login.trim().replace(/^@/, '');
    if (!value) return;
    setInviting(true);
    setError(null);
    try {
      replace(await api.teams.invite(team.id, { githubLogin: value }));
      setLogin('');
    } catch (err) {
      setError(errorText(err, 'Could not invite them.'));
    } finally {
      setInviting(false);
    }
  };

  const setRole = async (member: TeamMember, role: TeamRole) => {
    setError(null);
    try {
      replace(await api.teams.setRole(team.id, member.id, role));
      if (member.signedUp) void loadTeams();
    } catch (err) {
      setError(errorText(err, 'Could not change the role.'));
    }
  };

  const remove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    setError(null);
    try {
      await api.teams.removeMember(team.id, removing.id);
      const current = useSpacesStore.getState().members[team.id] ?? [];
      useSpacesStore.getState().setMembers(team.id, current.filter((m) => m.id !== removing.id));
      setRemoving(null);
    } catch (err) {
      setError(errorText(err, 'Could not remove them.'));
      setRemoving(null);
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <SettingsSection title="Members">
      {members === undefined ? (
        <div className="px-3 py-2">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : (
        members.map((member) => (
          <div key={member.id} className="flex items-center gap-3 px-3 py-2 text-[13px]" data-attr="team-member-row">
            <MemberAvatar member={member} size={22} />
            <div className="min-w-0 flex-1">
              <div className="truncate">@{member.githubLogin}</div>
              <div className="text-xs text-muted-foreground">
                {member.source === 'seat' ? 'Seat' : 'Invited'}
                {member.signedUp ? '' : ' · Not signed up yet'}
              </div>
            </div>
            {manage ? (
              <select
                className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
                value={member.role}
                onChange={(e) => void setRole(member, e.target.value as TeamRole)}
                aria-label={`Role of @${member.githubLogin}`}
              >
                {TEAM_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-xs text-muted-foreground">{ROLE_LABEL[member.role]}</span>
            )}
            {manage && (
              <button
                type="button"
                onClick={() => setRemoving(member)}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={`Remove @${member.githubLogin}`}
                title="Remove from the team"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))
      )}
      {manage && (
        <div className="flex items-center gap-2 px-3 py-2">
          <Input
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void invite();
            }}
            placeholder="GitHub username"
            className="h-8 flex-1"
            aria-label="GitHub username to invite"
          />
          <Button size="sm" onClick={() => void invite()} disabled={inviting || !login.trim()}>
            {inviting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <UserPlus className="mr-1 h-4 w-4" />}
            Invite
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="px-3 py-2 text-xs text-destructive" data-attr="team-members-error">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={removing !== null}
        title={removing ? `Remove @${removing.githubLogin}?` : 'Remove?'}
        description="They lose access to the team's spaces. Their own sessions stay in their workspace."
        confirmLabel="Remove"
        busy={removeBusy}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      />
    </SettingsSection>
  );
}

function SpacesSection({ team }: { team: SpacesTeam; manage: boolean }) {
  const openDialog = useSpacesStore((s) => s.openDialog);
  return (
    <SettingsSection
      title="Spaces"
      actions={
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => openDialog({ kind: 'createSpace', teamId: team.id })}>
          <Plus className="mr-1 h-3.5 w-3.5" /> New space
        </Button>
      }
    >
      {team.spaces.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">No spaces yet. Make one to start sharing sessions.</p>
      ) : (
        team.spaces.map((space) => <SpaceRow key={space.id} space={space} />)
      )}
    </SettingsSection>
  );
}

function SpaceRow({ space }: { space: Space }) {
  const repos = useSpacesStore((s) => s.repositories[space.id]);
  const openDialog = useSpacesStore((s) => s.openDialog);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(space.name);
  const [color, setColor] = useState(space.color);
  const [busy, setBusy] = useState(false);
  const [archiving, setArchiving] = useState(false);

  useEffect(() => {
    void loadSpaceRepositories(space.id);
  }, [space.id]);

  const save = async () => {
    setBusy(true);
    try {
      useSpacesStore.getState().upsertSpace(await api.spaces.update(space.id, { name: name.trim(), color }));
      setEditing(false);
    } catch (err) {
      toast.error('Could not save the space', errorText(err, ''));
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    setBusy(true);
    try {
      await api.spaces.archive(space.id);
      useSpacesStore.getState().removeSpace(space.id);
      setArchiving(false);
    } catch (err) {
      toast.error('Could not archive the space', errorText(err, ''));
      setArchiving(false);
    } finally {
      setBusy(false);
    }
  };

  const removeRepo = async (repoFullName: string) => {
    try {
      await api.spaces.removeRepository(space.id, repoFullName);
      const store = useSpacesStore.getState();
      store.setRepositories(space.id, (store.repositories[space.id] ?? []).filter((r) => r.repoFullName !== repoFullName));
    } catch (err) {
      toast.error('Could not remove the repository', errorText(err, ''));
    }
  };

  return (
    <div className="space-y-2 px-3 py-2 text-[13px]" data-attr="team-space-row">
      {editing ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              value={name}
              maxLength={MAX_SPACE_NAME_LENGTH}
              onChange={(e) => setName(e.target.value)}
              className="h-8 flex-1"
              aria-label="Space name"
              autoFocus
            />
            <Button size="sm" onClick={() => void save()} disabled={busy || !name.trim()}>
              <Check className="mr-1 h-3.5 w-3.5" /> Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy} aria-label="Cancel">
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <ColorPicker value={color} onChange={setColor} />
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <SpaceDot color={space.color} />
          <span className="min-w-0 flex-1 truncate font-medium">{space.name}</span>
          <button
            type="button"
            onClick={() => {
              setName(space.name);
              setColor(space.color);
              setEditing(true);
            }}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={`Edit ${space.name}`}
            title="Rename or change the colour"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setArchiving(true)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={`Archive ${space.name}`}
            title="Archive the space"
          >
            <Archive className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <ul className="space-y-0.5 pl-4">
        {(repos ?? []).map((r) => (
          <li key={r.repoFullName} className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate font-mono">{r.repoFullName}</span>
            <button
              type="button"
              onClick={() => void removeRepo(r.repoFullName)}
              className="rounded p-0.5 hover:bg-accent hover:text-foreground"
              aria-label={`Remove ${r.repoFullName} from ${space.name}`}
            >
              <X className="h-3 w-3" />
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => openDialog({ kind: 'addRepository', spaceId: space.id })}
          >
            Add repository…
          </button>
        </li>
      </ul>
      <ConfirmDialog
        open={archiving}
        title={`Archive ${space.name}?`}
        description="The space leaves the switcher for everyone. Its sessions stay in their owners' workspaces."
        confirmLabel="Archive"
        busy={busy}
        onConfirm={() => void archive()}
        onCancel={() => setArchiving(false)}
      />
    </div>
  );
}
