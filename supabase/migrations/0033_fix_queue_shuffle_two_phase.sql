-- 0033_fix_queue_shuffle_two_phase.sql
--
-- Fixes "duplicate key value violates unique constraint queue_player_type_pos_uniq"
-- thrown by queue_shuffle on every invocation.
--
-- ── Root cause ────────────────────────────────────────────────────────────────
--   The bijection UPDATE in migration 0029 is mathematically correct: it only
--   permutes the existing set of position values, never introducing new ones.
--   However, PostgreSQL's non-deferrable unique index check fires PER ROW as
--   each row is written, not at the end of the statement.
--
--   So when the UPDATE processes row A (moving it from position 5 to position 7),
--   row B still occupies position 7 — even though B will be moved later in the
--   same statement.  The constraint fires on A's write and the statement aborts.
--
-- ── Fix: two-phase position update ───────────────────────────────────────────
--   Phase 1 — move all non-current unplayed items to guaranteed-unique NEGATIVE
--             temp positions (-1, -2, -3 …).  This frees every original slot.
--             • -ROW_NUMBER() is always distinct → no inter-row conflict.
--             • Negative values never exist in normal operation → no conflict
--               with the now-playing item or any existing row.
--
--   Phase 2 — assign the shuffled final positions.
--             • All v_orig_positions values are free (Phase 1 cleared them).
--             • v_orig_positions has unique values → each target slot is distinct.
--             → Zero constraint violations in either phase.
--
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION queue_shuffle(
  p_player_id UUID,
  p_type      TEXT DEFAULT 'normal'
)
RETURNS void AS $$
DECLARE
  v_current_queue_id UUID;
  v_orig_positions   INT[];
  v_shuffled_ids     UUID[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));

  -- Identify the currently playing item so it is excluded from the shuffle.
  SELECT q.id INTO v_current_queue_id
  FROM   queue q
  JOIN   player_status ps
    ON   ps.player_id        = q.player_id
    AND  ps.current_media_id = q.media_item_id
  WHERE  q.player_id  = p_player_id
    AND  q.type       = p_type
    AND  q.played_at IS NULL
  LIMIT  1;

  -- Capture the positions we will reuse (sorted) and the IDs in random order.
  -- Pairing v_shuffled_ids[i] ↔ v_orig_positions[i] defines the shuffle mapping.
  SELECT
    array_agg(position ORDER BY position),
    array_agg(id       ORDER BY RANDOM())
  INTO v_orig_positions, v_shuffled_ids
  FROM queue
  WHERE player_id = p_player_id
    AND type      = p_type
    AND played_at IS NULL
    AND (v_current_queue_id IS NULL OR id != v_current_queue_id);

  -- Nothing to shuffle (0 or 1 items).
  IF v_orig_positions IS NULL OR array_length(v_orig_positions, 1) < 2 THEN
    RETURN;
  END IF;

  -- ── Phase 1: move all non-current items to unique negative temp positions ──
  --   -ROW_NUMBER() OVER (ORDER BY id) gives -1, -2, -3 … for every row.
  --   All distinct, all negative → guaranteed not to conflict with any existing
  --   positive position, with the now-playing item, or with each other.
  UPDATE queue q
  SET    position = temp.neg_pos
  FROM (
    SELECT id,
           (-ROW_NUMBER() OVER (ORDER BY id))::int AS neg_pos
    FROM   queue
    WHERE  player_id = p_player_id
      AND  type      = p_type
      AND  played_at IS NULL
      AND  (v_current_queue_id IS NULL OR id != v_current_queue_id)
  ) temp
  WHERE q.id = temp.id;

  -- ── Phase 2: assign final shuffled positions ───────────────────────────────
  --   v_orig_positions contains the original slots — all now free after Phase 1.
  --   v_orig_positions values are unique → each row gets a distinct target.
  --   No conflict possible.
  UPDATE queue q
  SET    position = t.new_pos
  FROM   unnest(v_shuffled_ids, v_orig_positions) AS t(item_id, new_pos)
  WHERE  q.id = t.item_id;

  PERFORM log_event(
    p_player_id,
    'queue_shuffle',
    'info',
    jsonb_build_object(
      'type',                  p_type,
      'now_playing_protected', v_current_queue_id IS NOT NULL
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION queue_shuffle(UUID, TEXT) TO authenticated, service_role;
