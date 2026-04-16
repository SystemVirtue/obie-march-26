-- =============================================================================
-- Migration: Robust queue position management
--
-- The root cause of queue corruption:
--   Positions are integer fields with a UNIQUE(player_id, type, position)
--   constraint. When rows are deleted, gaps form. Shuffle/reorder operations
--   that assume contiguous positions then fail with unique constraint
--   violations or produce wrong ordering.
--
-- Fix: a TRIGGER that resequences positions after any DELETE, maintaining
--   contiguous 0-based positions within each (player_id, type) partition.
--   The advisory lock in queue_next already serialises writes, so the trigger
--   won't introduce new conflicts.
--
-- Alternative considered: fractional positions (like Notion). Rejected because
--   it requires client-side precision and complicates the priority/normal
--   partition logic. Trigger-based resequencing is simpler and correct.
-- =============================================================================

-- ── Trigger function ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.queue_resequence_positions()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- After a DELETE, renumber all remaining rows in the same partition
  -- so positions are contiguous starting from 0.
  -- Uses a CTE to compute new positions atomically.
  WITH ranked AS (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY player_id, type
        ORDER BY position ASC
      ) - 1 AS new_position
    FROM public.queue
    WHERE player_id = OLD.player_id
      AND type      = OLD.type
  )
  UPDATE public.queue q
  SET    position = r.new_position
  FROM   ranked r
  WHERE  q.id = r.id
    AND  q.position <> r.new_position; -- Skip rows that don't need updating

  RETURN OLD;
END;
$$;

-- ── Attach trigger ───────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS queue_resequence_after_delete ON public.queue;

CREATE TRIGGER queue_resequence_after_delete
  AFTER DELETE ON public.queue
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_resequence_positions();

-- ── Clean up any existing gaps from prior played_at-based accumulation ───────

-- Resequence all existing rows per (player_id, type) partition
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY player_id, type
      ORDER BY position ASC
    ) - 1 AS new_position
  FROM public.queue
)
UPDATE public.queue q
SET    position = r.new_position
FROM   ranked r
WHERE  q.id = r.id
  AND  q.position <> r.new_position;

-- ── Verify ───────────────────────────────────────────────────────────────────

-- Check: no gaps should exist after this migration
-- Run manually to verify: 
-- SELECT player_id, type, array_agg(position ORDER BY position) as positions
-- FROM queue GROUP BY player_id, type;
