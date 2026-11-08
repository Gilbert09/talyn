-- Additive backend-only push storage. Existing binaries can ignore these tables.
CREATE TABLE mobile_installations (
 id text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK(provider = 'expo'), token_envelope jsonb NOT NULL, token_fingerprint text NOT NULL,
 platform text NOT NULL CHECK(platform IN ('ios','android')), environment text NOT NULL CHECK(environment IN ('development','preview','production')),
 app_identity text NOT NULL, app_version text NOT NULL, locale text NOT NULL, timezone text NOT NULL,
 last_seen_at timestamptz NOT NULL DEFAULT now(), disabled_at timestamptz, failure_state text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_mobile_installations_active_token ON mobile_installations(provider,token_fingerprint) WHERE disabled_at IS NULL;
CREATE INDEX idx_mobile_installations_owner ON mobile_installations(owner_id);
CREATE INDEX idx_mobile_installations_fingerprint ON mobile_installations(token_fingerprint);
CREATE INDEX idx_mobile_installations_last_seen ON mobile_installations(last_seen_at);
--> statement-breakpoint
CREATE TABLE mobile_notification_preferences (
 owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 preferences jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,workspace_id)
);
--> statement-breakpoint
CREATE TABLE mobile_notification_outbox (
 id text PRIMARY KEY, event_id text NOT NULL, owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 installation_id text NOT NULL REFERENCES mobile_installations(id) ON DELETE CASCADE, token_fingerprint text NOT NULL,
 category text NOT NULL CHECK(category IN ('session_update','pr_review','ci_failure','merge_ready','human_gate')),
 destination jsonb NOT NULL, deduplication_key text NOT NULL, not_before timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0, state text NOT NULL DEFAULT 'pending',
 lease_id text, lease_until timestamptz, provider_ticket_id text, receipt_state text NOT NULL DEFAULT 'none',
 receipt_attempts integer NOT NULL DEFAULT 0, receipt_after timestamptz, last_error_class text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_mobile_notification_outbox_dedup ON mobile_notification_outbox(owner_id,installation_id,deduplication_key);
CREATE INDEX idx_mobile_notification_outbox_claim ON mobile_notification_outbox(state,not_before,lease_until);
CREATE INDEX idx_mobile_notification_outbox_expiry ON mobile_notification_outbox(expires_at);
CREATE INDEX idx_mobile_notification_outbox_receipts ON mobile_notification_outbox(receipt_state,receipt_after);
CREATE INDEX idx_mobile_notification_outbox_owner ON mobile_notification_outbox(owner_id,event_id);
--> statement-breakpoint
CREATE TABLE mobile_notification_audit (
 id text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_mobile_notification_audit_owner ON mobile_notification_audit(owner_id,created_at);
--> statement-breakpoint
ALTER TABLE mobile_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_notification_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mobile_installations,mobile_notification_preferences,mobile_notification_outbox,mobile_notification_audit FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','talyn_backend') LOOP
  EXECUTE format('REVOKE ALL ON mobile_installations,mobile_notification_preferences,mobile_notification_outbox,mobile_notification_audit FROM %I', role_name);
 END LOOP;
END $$;
