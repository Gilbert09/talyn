import type { LinearEditorOptions } from '@talyn/shared';
import { linearGraphql } from './api.js';
import { linearAccessToken } from './store.js';

/**
 * The Linear issue calls an issue rule makes, with the connection's token:
 * read an issue (for a comment event and for the prompt), comment, move the
 * issue to a state, and the rule editor's lists. The agent never holds this
 * token.
 */

export interface LinearIssueDetail {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  priority: string | null;
  teamId: string | null;
  teamKey: string | null;
  state: string | null;
  project: string | null;
  labels: string[];
  assigneeId: string | null;
  assignee: string | null;
  delegateId: string | null;
  comments: Array<{ id: string; body: string; author: string | null; createdAt: string | null }>;
}

/**
 * How many recent comments the prompt quotes. The newest ten carry the
 * current state of a discussion; older ones are on the issue, one link away.
 */
export const RECENT_COMMENTS = 10;

const ISSUE_QUERY = `query TalynIssue($id: String!) {
  issue(id: $id) {
    id identifier title description url priorityLabel
    team { id key }
    state { name }
    project { name }
    assignee { id name displayName }
    delegate { id }
    labels { nodes { name } }
    comments(last: ${RECENT_COMMENTS}) { nodes { id body createdAt user { name displayName } } }
  }
}`;

interface IssueDoc {
  issue?: {
    id?: string;
    identifier?: string;
    title?: string;
    description?: string | null;
    url?: string;
    priorityLabel?: string | null;
    team?: { id?: string; key?: string } | null;
    state?: { name?: string } | null;
    project?: { name?: string } | null;
    assignee?: { id?: string; name?: string; displayName?: string } | null;
    delegate?: { id?: string } | null;
    labels?: { nodes?: Array<{ name?: string }> } | null;
    comments?: {
      nodes?: Array<{ id?: string; body?: string; createdAt?: string; user?: { name?: string; displayName?: string } | null }>;
    } | null;
  } | null;
}

export async function fetchLinearIssue(connectionId: string, issueId: string): Promise<LinearIssueDetail | null> {
  const token = await linearAccessToken(connectionId);
  const doc = await linearGraphql<IssueDoc>(token, ISSUE_QUERY, { id: issueId }, { connectionId });
  const i = doc.issue;
  if (!i?.id) return null;
  return {
    id: i.id,
    identifier: i.identifier ?? '',
    title: i.title ?? '',
    description: i.description ?? '',
    url: i.url ?? '',
    priority: i.priorityLabel ?? null,
    teamId: i.team?.id ?? null,
    teamKey: i.team?.key ?? null,
    state: i.state?.name ?? null,
    project: i.project?.name ?? null,
    labels: (i.labels?.nodes ?? []).map((l) => l.name ?? '').filter(Boolean),
    assigneeId: i.assignee?.id ?? null,
    assignee: i.assignee?.displayName ?? i.assignee?.name ?? null,
    delegateId: i.delegate?.id ?? null,
    comments: (i.comments?.nodes ?? []).map((c) => ({
      id: c.id ?? '',
      body: c.body ?? '',
      author: c.user?.displayName ?? c.user?.name ?? null,
      createdAt: c.createdAt ?? null,
    })),
  };
}

const COMMENT_MUTATION = `mutation TalynComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
}`;

/** Comment on an issue as Talyn's app user. Answers the comment id. */
export async function createLinearComment(connectionId: string, issueId: string, body: string): Promise<string | null> {
  const token = await linearAccessToken(connectionId);
  const doc = await linearGraphql<{ commentCreate?: { success?: boolean; comment?: { id?: string } | null } }>(
    token,
    COMMENT_MUTATION,
    { issueId, body },
    { connectionId }
  );
  return doc.commentCreate?.comment?.id ?? null;
}

const TEAM_STATES_QUERY = `query TalynTeamStates($teamId: String!) {
  team(id: $teamId) { states { nodes { id name type position } } }
}`;

interface StateNode {
  id?: string;
  name?: string;
  type?: string;
  position?: number;
}

/**
 * The state `status` names in a team. `done` is the team's first state of
 * type `completed` (lowest position), which is Linear's "Done" unless the
 * team renamed or reordered it. Any other value is a state name.
 */
export function pickLinearState(states: StateNode[], status: string): { id: string; name: string } | null {
  const wanted = status.trim().toLowerCase();
  if (wanted === 'done') {
    const completed = states
      .filter((s) => s.type === 'completed' && s.id)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    return completed[0]?.id ? { id: completed[0].id, name: completed[0].name ?? 'Done' } : null;
  }
  const match = states.find((s) => (s.name ?? '').trim().toLowerCase() === wanted && s.id);
  return match?.id ? { id: match.id, name: match.name ?? status } : null;
}

const UPDATE_STATE_MUTATION = `mutation TalynIssueState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success }
}`;

/** Move an issue to a state. Throws when the team has no such state. */
export async function setLinearIssueState(
  connectionId: string,
  issueId: string,
  teamId: string,
  status: string
): Promise<string> {
  const token = await linearAccessToken(connectionId);
  const doc = await linearGraphql<{ team?: { states?: { nodes?: StateNode[] } } | null }>(
    token,
    TEAM_STATES_QUERY,
    { teamId },
    { connectionId }
  );
  const state = pickLinearState(doc.team?.states?.nodes ?? [], status);
  if (!state) throw new Error(status === 'done' ? 'The Linear team has no completed state.' : `The Linear team has no state named "${status}".`);
  await linearGraphql(token, UPDATE_STATE_MUTATION, { id: issueId, stateId: state.id }, { connectionId });
  return state.name;
}

/**
 * The editor's lists. Linear's page size is at most 250; a workspace with
 * more teams, labels or states than one page is rare, and a missing one can
 * still be typed.
 */
const OPTIONS_QUERY = `query TalynEditorOptions {
  teams(first: 100) { nodes { id key name } }
  issueLabels(first: 250) { nodes { id name team { id } } }
  workflowStates(first: 250) { nodes { id name type position team { id } } }
  projects(first: 100) { nodes { id name } }
}`;

interface OptionsDoc {
  teams?: { nodes?: Array<{ id?: string; key?: string; name?: string }> };
  issueLabels?: { nodes?: Array<{ id?: string; name?: string; team?: { id?: string } | null }> };
  workflowStates?: { nodes?: Array<StateNode & { team?: { id?: string } | null }> };
  projects?: { nodes?: Array<{ id?: string; name?: string }> };
}

/** How long the editor's lists are cached per connection. A person setting up a rule opens the editor a few times in a minute. */
const OPTIONS_TTL_MS = 60_000;
const optionsCache = new Map<string, { at: number; value: LinearEditorOptions }>();

export function resetLinearOptionsCacheForTests(): void {
  optionsCache.clear();
}

export async function linearEditorOptions(connectionId: string, now = Date.now()): Promise<LinearEditorOptions> {
  const cached = optionsCache.get(connectionId);
  if (cached && now - cached.at < OPTIONS_TTL_MS) return cached.value;
  try {
    const token = await linearAccessToken(connectionId);
    const doc = await linearGraphql<OptionsDoc>(token, OPTIONS_QUERY, {}, { connectionId });
    const value: LinearEditorOptions = {
      teams: (doc.teams?.nodes ?? []).filter((t) => t.id).map((t) => ({ id: t.id!, key: t.key ?? '', name: t.name ?? '' })),
      labels: (doc.issueLabels?.nodes ?? []).filter((l) => l.id).map((l) => ({ id: l.id!, name: l.name ?? '', teamId: l.team?.id ?? null })),
      states: (doc.workflowStates?.nodes ?? [])
        .filter((s) => s.id && s.team?.id)
        .map((s) => ({ id: s.id!, name: s.name ?? '', type: s.type ?? '', position: s.position ?? 0, teamId: s.team!.id! })),
      projects: (doc.projects?.nodes ?? []).filter((p) => p.id).map((p) => ({ id: p.id!, name: p.name ?? '' })),
      partial: false,
    };
    optionsCache.set(connectionId, { at: now, value });
    return value;
  } catch {
    // A picker with no suggestions is still a working text field.
    return { teams: [], labels: [], states: [], projects: [], partial: true };
  }
}
