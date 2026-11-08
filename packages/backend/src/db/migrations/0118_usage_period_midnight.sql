-- Usage periods reset at 00:00 UTC on the billing day, not at the time of
-- day the subscription began (Tom, 2026-11-08). usagePeriodFor now cuts a
-- subscriber's anchor to midnight, so a row that still starts at, say, 09:00
-- would no longer be found and the meter would open an empty period for the
-- same month. Move every stored boundary to midnight UTC on its date.
-- A row whose new start another row of the same owner already holds is left
-- as it is (none existed in production when this was written).
UPDATE "usage_periods" p
SET "period_start" = date_trunc('day', p."period_start", 'UTC'),
	"period_end" = date_trunc('day', p."period_end", 'UTC')
WHERE (p."period_start" <> date_trunc('day', p."period_start", 'UTC')
		OR p."period_end" <> date_trunc('day', p."period_end", 'UTC'))
	AND NOT EXISTS (
		SELECT 1 FROM "usage_periods" o
		WHERE o."owner_id" = p."owner_id"
			AND o."period_start" = date_trunc('day', p."period_start", 'UTC')
			AND o."period_start" <> p."period_start"
	);
--> statement-breakpoint
UPDATE "credit_ledger"
SET "period_start" = date_trunc('day', "period_start", 'UTC')
WHERE "period_start" IS NOT NULL AND "period_start" <> date_trunc('day', "period_start", 'UTC');
