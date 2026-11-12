-- The highest memory a box used during one usage interval, in MiB.
--
-- A box is billed at the smallest size whose memory holds what it uses
-- (`billedSizeFor`), so the operator console shows this figure next to each
-- interval's cost. The usage sweep reads each running box's memory once a
-- minute and raises the value with GREATEST. NULL means no reading yet: the
-- interval opened from a lifecycle hook and closed before a sweep saw it, or
-- the host did not report memory.
ALTER TABLE "usage_intervals" ADD COLUMN IF NOT EXISTS "peak_mem_used_mib" integer;
