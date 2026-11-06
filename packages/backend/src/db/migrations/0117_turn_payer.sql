-- Teams and Spaces, phase 3: the prompter pays.
--
-- workbench_chats.payer_user_id / payer_workspace_id: who pays for the chat's
-- latest turn when a teammate prompted it. They are set in the statement that
-- starts the turn and stay after it ends, so the box's current payer is the
-- payer of the latest turn. NULL means the session's owner: every existing
-- row, every owner turn and every turn Talyn starts for the owner.
--
-- usage_intervals.payer_user_id: set when the interval bills a teammate. The
-- interval's owner_id is then that teammate, so the charge step, the budget
-- and exhaustion read the payer with no change. NULL means the workspace owner.
ALTER TABLE workbench_chats ADD COLUMN payer_user_id text, ADD COLUMN payer_workspace_id text;
--> statement-breakpoint
ALTER TABLE usage_intervals ADD COLUMN payer_user_id text;
