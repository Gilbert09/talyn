import type { Workbench, WorkbenchAgent, WorkbenchKind, WorkbenchSandboxState, WorkbenchStatus } from './workbench.js';
import type { TaskStatus, TaskType } from './index.js';

/**
 * Teams and Spaces: the contract of `/api/v1/teams` and `/api/v1/spaces`.
 *
 * A team is the multiplayer entity. A space belongs to a team and holds
 * sessions and tasks. Each session or task still runs in its creator's own
 * workspace: nothing here shares a workspace or a credential. Gated by the
 * `spaces` flag.
 */

export const TEAM_ROLES = ['owner', 'admin', 'member'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/** How a person became a member: an invite by GitHub login, or a paid seat. */
export type TeamMemberSource = 'invite' | 'seat';

export const MAX_SPACE_NAME_LENGTH = 60;
export const MAX_TEAM_NAME_LENGTH = 80;
/** A space colour is a `#rrggbb` hex string. */
export const SPACE_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
/**
 * A space image is a downscaled raster `data:` URL, stored inline on the space
 * row. Every `GET /teams` sends it to every member, so it stays small: the
 * apps downscale an upload to `SPACE_IMAGE_MAX_DIMENSION` px before they send it.
 */
export const SPACE_IMAGE_PATTERN = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
export const MAX_SPACE_IMAGE_LENGTH = 256 * 1024;
export const SPACE_IMAGE_MAX_DIMENSION = 128;

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === 'string' && (TEAM_ROLES as readonly string[]).includes(value);
}

/** Owners and admins manage members and roles. */
export function canManageTeam(role: TeamRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export interface Space {
  id: string;
  teamId: string;
  name: string;
  color: string | null;
  /** An uploaded image (`data:image/...`) shown in place of the colour tile. Null: none. */
  image: string | null;
  createdByUserId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One team as the caller sees it: their role, their home workspace and the live spaces. */
export interface SpacesTeam {
  id: string;
  name: string;
  role: TeamRole;
  /** The caller's own workspace that hosts and pays for their work in this team. Null: they own none. */
  homeWorkspaceId: string | null;
  spaces: Space[];
  createdAt: string;
}

export interface TeamMember {
  id: string;
  teamId: string;
  githubUserId: number;
  githubLogin: string;
  avatarUrl: string | null;
  role: TeamRole;
  source: TeamMemberSource;
  /** False until the person signs in to Talyn. */
  signedUp: boolean;
  createdAt: string;
}

export interface SpaceRepository {
  spaceId: string;
  repoFullName: string;
  githubRepoId: number | null;
  createdAt: string;
}

/** Who made a session or task in a space. */
export interface SpaceItemCreator {
  userId: string;
  githubLogin: string | null;
  avatarUrl: string | null;
}

/** A session in a space's sidebar. No sandbox, device or credential field. */
export interface SpaceSessionRow {
  id: string;
  spaceId: string;
  workspaceId: string;
  /** A thread has no repository, so only its owner can see it. */
  kind: WorkbenchKind;
  /** The thread that started this session, when there is one. */
  threadId: string | null;
  name: string;
  title: string | null;
  status: WorkbenchStatus;
  sandboxState: WorkbenchSandboxState;
  /** A chat of this session runs a turn now. */
  running: boolean;
  repoFullName: string;
  branch: string;
  baseBranch: string;
  agent: WorkbenchAgent;
  model: string | null;
  pullRequest: { number: number; state: string; url: string } | null;
  creator: SpaceItemCreator;
  lastActivityAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A task in a space. No prompt, metadata or result body. */
export interface SpaceTaskRow {
  id: string;
  spaceId: string;
  workspaceId: string;
  type: TaskType;
  status: TaskStatus;
  title: string;
  repoFullName: string | null;
  branch: string | null;
  pullRequest: { number: number; state: string; url: string } | null;
  creator: SpaceItemCreator;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/**
 * The items of a space the caller may see. `hiddenCount` counts the items in
 * repositories the caller's GitHub account cannot read.
 */
export interface SpaceItemsResponse<T> {
  items: T[];
  hiddenCount: number;
}

export interface CreateSpacesTeamRequest {
  name: string;
}

export interface CreateSpaceRequest {
  name: string;
  color?: string | null;
  image?: string | null;
}

export interface UpdateSpaceRequest {
  name?: string;
  color?: string | null;
  /** Null removes the image. Absent leaves it as it is. */
  image?: string | null;
}

export interface InviteTeamMemberRequest {
  githubLogin: string;
}

export interface CreateSpaceSessionRequest {
  /** Default 'session'. A thread takes no repository, branch or base branch. */
  kind?: WorkbenchKind;
  /** Required for a session. */
  repoFullName?: string;
  agent: WorkbenchAgent;
  model?: string;
  prompt?: string;
  name?: string;
  baseBranch?: string;
  branch?: string;
  /** Start from an open pull request of my home workspace on this repository. Session only. */
  fromPullRequestId?: string;
  internetAccess?: boolean;
  /** Session only. */
  autoCreatePr?: boolean;
  /** Names the session when the first message goes separately, as on `CreateWorkbenchInput`. */
  namingText?: string;
}

export interface CreateSpaceSessionResponse {
  workbench: Workbench;
  /** The caller's workspace the session runs in. */
  workspaceId: string;
  /** True when Talyn added the repository to that workspace first. */
  addedRepository: boolean;
}

export interface MoveToSpaceRequest {
  /** Null moves the item back to Personal. */
  spaceId: string | null;
}

export interface SpacePresenceMember extends SpaceItemCreator {
  sessionId: string | null;
  state: 'active' | 'away';
  /** Time of the last heartbeat, in milliseconds since the Unix epoch. */
  at: number;
}

export interface SubscribeSpaceMessage {
  type: 'subscribe_space';
  spaceId: string;
}

export interface UnsubscribeSpaceMessage {
  type: 'unsubscribe_space';
  spaceId: string;
}

export interface SpacePresenceMessage {
  type: 'presence';
  spaceId: string;
  sessionId: string | null;
  state: SpacePresenceMember['state'];
}

export type SpaceClientMessage = SubscribeSpaceMessage | UnsubscribeSpaceMessage | SpacePresenceMessage;

export interface SpacePresenceEvent {
  type: 'space:presence';
  payload: { spaceId: string; members: SpacePresenceMember[] };
  timestamp: string;
}
