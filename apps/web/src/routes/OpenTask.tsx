import { useEffect } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { PANEL_PATHS } from '../lib/routes';
import { useWorkspaceStore } from '../stores/workspace';

/**
 * The link Talyn posts on an issue for a task it started. There is no desktop
 * deep link for a task, so this opens the task in the browser: it selects the
 * task and goes to the task list, which shows the selected task.
 */
export function OpenTask() {
  const { id } = useParams();
  useEffect(() => {
    if (id) useWorkspaceStore.getState().selectTask(id);
  }, [id]);
  return <Navigate to={PANEL_PATHS.queue} replace />;
}
