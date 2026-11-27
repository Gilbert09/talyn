import type { CreateWorkbenchInput, SendWorkbenchMessageInput, Workbench, WorkbenchChat } from './workbench.js';

export interface WorkbenchCreation {
  workbench: Workbench;
  chat: WorkbenchChat;
  message: SendWorkbenchMessageInput;
}

type CreationInput = Pick<CreateWorkbenchInput,
  'workspaceId' | 'kind' | 'repositoryId' | 'branch' | 'baseBranch' | 'runtime' | 'agent' | 'model' | 'internetAccess'
> & {
  id: string;
  repoFullName?: string;
  spaceId?: string;
  effort?: WorkbenchChat['effort'];
  planMode?: boolean;
  message: SendWorkbenchMessageInput;
};

/** Data for the session view while the server assigns its ID. Keep it out of the session cache. */
export function workbenchCreation(input: CreationInput): WorkbenchCreation {
  const { id, workspaceId, kind, repoFullName, runtime, agent, model, message } = input;
  const name = kind === 'thread' ? 'New thread' : 'New session';
  const now = new Date().toISOString();
  const chat: WorkbenchChat = {
    id, workbenchId: id, title: name, agent, model: model ?? null, effort: input.effort ?? null,
    planMode: input.planMode ?? false, agentSessionId: null, status: 'idle', queuedMessages: [], createdAt: now, updatedAt: now,
  };
  const workbench: Workbench = {
    id, workspaceId, kind, repositoryId: input.repositoryId ?? null, repoFullName: repoFullName ?? '',
    name, title: name, branch: input.branch?.trim() ?? '', baseBranch: input.baseBranch?.trim() ?? '',
    runtime, agent, model, deviceId: null, localPath: null, sandboxId: null, sandboxState: 'creating', status: 'provisioning',
    statusMessage: kind === 'thread' ? 'Creating the thread…' : 'Creating the session…',
    pullRequestId: null, settings: { internetAccess: input.internetAccess }, diffStat: null, spaceId: input.spaceId,
    chats: [chat], archivedAt: null, createdAt: now, updatedAt: now,
  };
  return { workbench, chat, message };
}
