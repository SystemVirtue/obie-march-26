-- =============================================================================
-- Fix queue_shuffle: NEVER touch position 0
--
-- Problem: With the delete-based queue system, queue_shuffle's method of
-- finding the "currently playing" item via player_status.current_media_id JOIN
-- no longer works reliably (the current item is deleted immediately when
-- queue_next runs).
--
-- Fix: Position 0 is SACRED - queue_shuffle will NEVER touch it.
--   - Only shuffle items at position >= 1
--   - Position 0 is excluded entirely from the shuffle
--   - This ensures the next-up item stays at position 0
-- =============================================================================

CREATE OR REPLACE FUNCTION queue_shuffle(
  p_player_id UUID,
  p_type      TEXT DEFAULT 'normal'
)
RETURNS void AS $$
DECLARE
  v_position_0_id    UUID;    -- queue.id of item at position 0 (NEVER TOUCH THIS)
  v_orig_positions   INT[];
  v_shuffled_ids       UUID[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));

  -- Capture the sacred position 0 item (if any).
  -- Position 0 is NEVER shuffled - it stays exactly where it is.
  SELECT q.id INTO v_position_0_id
  FROM   queue q
  WHERE  q.player_id = p_player_id
    AND  q.type      = p_type
    AND  q.position  = 0
  LIMIT  1;

  -- Capture positions and IDs for shuffling, EXCLUDING position 0.
  -- Only items at position >= 1 are eligible for shuffling.
  SELECT
    array_agg(position ORDER BY position),
    array_agg(id       ORDER BY RANDOM())
  INTO v_orig_positions, v_shuffled_ids
  FROM queue
  WHERE player_id = p_player_id
    AND type      = p_type
    AND position  >= 1;

  -- Nothing to shuffle (0 or 1 items beyond position 0).
  IF v_orig_positions IS NULL OR array_length(v_orig_positions, 1) < 2 THEN
    RETURN;
  END IF;

  -- Phase 1: move all position >= 1 items to unique negative temp positions.
  -- This frees up the original positive slots without touching position 0.
  UPDATE queue q
  SET    position = temp.neg_pos
  FROM (
    SELECT id,
           (-ROW_NUMBER() OVER (ORDER BY id))::int AS neg_pos
    FROM   queue
    WHERE  player_id = p_player_id
      AND  type      = p_type
      AND  position  >= 1
  ) temp
  WHERE q.id = temp.id;

  -- Phase 2: assign final shuffled positions (still only to position >= 1 items).
  UPDATE queue q
  SET    position = t.new_pos
  FROM   unnest(v_shuffled_ids, v_orig_positions) AS t(item_id, new_pos)
  WHERE  q.id = t.item_id;

  PERFORM log_event(
    p_player_id,
    'queue_shuffle',
    'info',
    jsonb_build_object(
      'type',               p_type,
      'position_0_protected', v_position_0_id IS NOT NULL,
      'shuffled_count',   array_length(v_shuffled_ids, 1)
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION queue_shuffle(UUID, TEXT) TO authenticated, service_role;
