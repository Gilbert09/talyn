ALTER TABLE users ADD COLUMN review_ranking_opt_out boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE users SET review_ranking_opt_out = true
WHERE id IN (SELECT user_id FROM review_ranking_participants WHERE NOT enabled);
