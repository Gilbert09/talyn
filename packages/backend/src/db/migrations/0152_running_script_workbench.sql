CREATE INDEX "idx_workbench_script_runs_running_workbench"
  ON "workbench_script_runs" ("workbench_id") WHERE "running";
