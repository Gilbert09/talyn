/**
 * The tools a SESSION's own token may call (`talyn_mcs_`, the `talyn` server in
 * a session sandbox). An allow-list, checked by the server on every list and
 * every call, so a tool added later is refused until somebody decides it is
 * safe here.
 *
 * The agent behind this token reads untrusted text — pull requests, review
 * threads, Slack messages — so anything that could move a credential or change
 * the account stays out:
 * - MCP server tools: they create, connect and delete stored credentials.
 * - Account tools (billing, cloud providers, what's new): account surfaces.
 * - Repository add/remove, and skill, workflow and loop create/edit/delete/run:
 *   workspace configuration that outlives the session. Their reads are in.
 * (MCP token, credential and sign-in tools are not exposed to any token.)
 *
 * In: sessions, the merge queue, pull requests, code review and tasks — the
 * work a session does on its owner's behalf. Also workspace memory: the
 * session's own notes. A session writes to its own repository unless it asks
 * for the workspace, and each write shows as a card in its transcript.
 */
export const SESSION_TOKEN_TOOLS: ReadonlySet<string> = new Set([
  // Workspaces and repositories (read)
  'talyn_list_workspaces',
  'talyn_get_workspace',
  'talyn_list_repositories',
  'talyn_list_github_repos',
  // Pull requests
  'talyn_list_pull_requests',
  'talyn_get_pull_request',
  'talyn_get_pull_request_diff',
  'talyn_get_pull_request_reviews',
  'talyn_get_pull_request_description',
  'talyn_refresh_pull_request',
  'talyn_set_auto_keep_mergeable',
  'talyn_set_merge_queue',
  'talyn_merge_pull_request',
  'talyn_fix_pull_request',
  // track/untrack are a person's choice, so they are not here: a session's own
  // PR is already shown by the session.
  'talyn_set_review_hidden',
  // Merge queue
  'talyn_set_merge_queue_stack',
  'talyn_get_merge_queue_timeline',
  // Code review
  'talyn_get_code_review',
  'talyn_list_code_reviews',
  'talyn_get_code_review_finding',
  'talyn_start_code_review',
  'talyn_cancel_code_review',
  'talyn_fix_code_review_findings',
  'talyn_dismiss_code_review_finding',
  // Tasks
  'talyn_create_task',
  'talyn_list_tasks',
  'talyn_get_task',
  'talyn_stop_task',
  'talyn_retry_task',
  'talyn_delete_task',
  // Sessions (self-calls are guarded in the tools themselves)
  'talyn_list_sessions',
  'talyn_get_session',
  'talyn_create_session',
  'talyn_list_thread_sessions',
  'talyn_send_session_message',
  'talyn_list_accounts',
  'talyn_set_session_account',
  // It can also set the repository's default size: a sandbox size moves no
  // credential, and the person can change it back in the repository settings.
  'talyn_resize_session',
  'talyn_get_session_transcript',
  'talyn_cancel_session_turn',
  'talyn_get_session_changes',
  'talyn_get_session_diff',
  'talyn_open_session_pull_request',
  'talyn_run_session_script',
  'talyn_stop_session_script',
  'talyn_archive_session',
  'talyn_restore_session',
  'talyn_retry_session',
  'talyn_session_timing',
  // Repository setup that outlives the session, allowed on purpose: the
  // backend refuses secrets, downloaded scripts piped into a shell and data
  // egress, logs each step with its session, and a person can revert it.
  'talyn_record_setup_step',
  // Reading the steps is safe. Reverting is not here: it undoes setup that a
  // person or another session chose, and an agent that reads untrusted text
  // should not remove it. A person reverts steps in the app or with a user token.
  'talyn_list_setup_steps',
  // Workspace memory
  'talyn_memory_write',
  'talyn_memory_search',
  'talyn_memory_read',
  'talyn_memory_forget',
  'talyn_memory_list',
  // Skills, workflows and loops (read)
  'talyn_list_skills',
  'talyn_get_skill',
  'talyn_list_workflows',
  'talyn_get_workflow',
  'talyn_get_workflow_vocabulary',
  'talyn_list_workflow_runs',
  'talyn_list_loops',
  'talyn_get_loop',
  'talyn_list_loop_runs',
]);

export function toolAllowedForCaller(name: string, session: unknown): boolean {
  return !session || SESSION_TOKEN_TOOLS.has(name);
}
