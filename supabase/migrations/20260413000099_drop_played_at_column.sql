-- =============================================================================
-- Drop the dead played_at column from the queue table.
--
-- DEPLOY ORDER: Run this migration AFTER the frontend code that removes
-- .is('played_at', null) filters is deployed. If the /main branch frontend
-- is still running .is('played_at', null) queries, PostgREST will 400
-- on the missing column. The frontend changes in this PR remove those filters.
--
-- Since migration 20260409000001, queue_next DELETEs played items instead of
-- marking played_at = NOW(). The column is never written to and all frontend
-- .is('played_at', null) filters are no-ops (all rows have NULL played_at).
-- Dropping it reduces row width and eliminates confusion.
-- =============================================================================

ALTER TABLE public.queue DROP COLUMN IF EXISTS played_at;
