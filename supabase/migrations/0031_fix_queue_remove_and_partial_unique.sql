-- 0031_fix_queue_remove_and_partial_unique.sql
--
-- Two related fixes for "duplicate key value violates unique constraint
-- queue_player_id_type_position_key" errors.
--
-- ── Root cause A: constraint covers played rows ─────────────────────────────
--   UNIQUE(player_id, type, position) applies to ALL rows, including those
--   with played_at IS NOT NULL.  This makes every position-shifting operation
--   (queue_remove, queue_reorder, queue_shuffle) potentially conflict with
--   historical played rows that still occupy their original positions.
--
--   Fix: drop the table-level constraint and replace it with a partial unique
--   index that only enforces uniqueness among UNPLAYED items.
--   Played rows are history — they don't need unique positions.
--
-- ── Root cause B: compaction UPDATE in queue_remove ─────────────────────────
--   The original queue_remove did:
--     DELETE item at position P;
--     UPDATE SET position = position - 1 WHERE position > P AND played_at IS NULL;
--
--   Postgres processes rows in an undefined order.  If it processes position P+2
--   before P+1, it tries to set P+2 → P+1 while the row at P+1 has not yet
--   been moved, causing a uniqueness conflict (even with the partial index,
--   because both rows are unplayed).
--
--   Fix: remove the compaction step entirely.  Gaps in positions are harmless:
--     • queue_next/queue_skip — ORDER BY position ASC: works with gaps.
--     • queue_shuffle (0029)  — redistributes existing positions: works.
--     • queue_reorder         — reassigns explicit compact positions: normalises.
--     • queue_add             — uses MAX(position)+1: just a higher number, fine.
--     • load_playlist (0030)  — deletes and re-inserts: normalises.
--
-- ─────────────────────────────────────────────────────────────────────────────

-- 1.  Replace full unique constraint with a partial unique index
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE queue
  DROP CONSTRAINT IF EXISTS queue_player_id_type_position_key;

-- Only unplayed items need unique positions within (player, type).
CREATE UNIQUE INDEX IF NOT EXISTS queue_player_type_pos_uniq
  ON queue (player_id, type, position)
  WHERE played_at IS NULL;


-- 2.  Fix queue_remove — delete item, leave positions as-is
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION queue_remove(
  p_queue_id UUID
)
RETURNS void AS $$
DECLARE
  v_player_id UUID;
  v_type      TEXT;
BEGIN
  -- Fetch enough to lock and log; reject already-played items.
  SELECT player_id, type INTO v_player_id, v_type
  FROM   queue
  WHERE  id = p_queue_id AND played_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Queue item not found or already played';
  END IF;

  -- Acquire the same advisory lock used by all other queue RPCs.
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || v_player_id::text));

  -- Hard-delete the item.  No position compaction — gaps are harmless.
  -- All queue consumers ORDER BY position ASC, so the display and playback
  -- order remain correct.  The next queue_reorder or load_playlist call
  -- will normalise positions automatically.
  DELETE FROM queue WHERE id = p_queue_id;

  PERFORM log_event(
    v_player_id,
    'queue_remove',
    'info',
    jsonb_build_object('queue_id', p_queue_id, 'type', v_type)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION queue_remove(UUID) TO authenticated, service_role;
