import type { PRState } from '@talyn/client';
import { workbenchQueuesMessages, type WorkbenchKind } from '@talyn/shared';

export const exampleWorkbenchKinds: readonly WorkbenchKind[] = ['session', 'thread'];
export const examplePullRequestState: PRState = 'open';
export const exampleSessionQueuesMessages = workbenchQueuesMessages('ready');
