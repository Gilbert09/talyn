import { api } from './api';
import { openExternal } from './openExternal';

export async function startSlackInstall(workspaceId: string | null): Promise<void> {
  const { authorizeUrl } = await api.slack.install(workspaceId ? { workspaceId } : {});
  await openExternal(authorizeUrl);
}
