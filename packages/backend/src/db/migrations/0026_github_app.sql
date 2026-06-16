CREATE TABLE "github_installations" (
	"installation_id" text PRIMARY KEY NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"repo_full_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_github_installations_account" ON "github_installations" USING btree ("account_login");
--> statement-breakpoint
-- App-owned infrastructure, not user data: the webhook pipeline reads it as the
-- privileged pool role, and there is no per-owner scoping (one installation can
-- back many owners' workspaces). RLS stays OFF — mirrors `settings`, the other
-- global table. The integration row that links a workspace to an installation
-- (and the per-workspace user token) remains the RLS-protected, owner-scoped record.
