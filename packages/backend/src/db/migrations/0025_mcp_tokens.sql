CREATE TABLE "mcp_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_mcp_tokens_token_hash" ON "mcp_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "idx_mcp_tokens_owner" ON "mcp_tokens" USING btree ("owner_id");
--> statement-breakpoint
-- Defense in depth, mirroring the other owner tables (0002/0024): the backend
-- pool connects as the privileged role and bypasses RLS (which is how the
-- unscoped validate-by-hash lookup works), but a JWT/anon connection only ever
-- sees its own tokens. The token-CRUD routes run owner-scoped as `authenticated`.
ALTER TABLE "mcp_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "mcp_tokens_owner" ON "mcp_tokens" FOR ALL
  USING (owner_id = auth.uid()::text)
  WITH CHECK (owner_id = auth.uid()::text);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "mcp_tokens" TO "authenticated";
