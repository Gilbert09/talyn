import { api } from './api';

export async function startSlackInstall(workspaceId: string | null): Promise<void> {
  const { authorizeUrl } = await api.slack.install(workspaceId ? { workspaceId } : {});
  window.location.assign(authorizeUrl);
}
