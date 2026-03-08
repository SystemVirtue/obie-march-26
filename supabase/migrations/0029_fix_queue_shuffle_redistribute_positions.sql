-- 0029_fix_queue_shuffle_redistribute_positions.sql
--
-- Fixes the duplicate-key error in queue_shuffle.
--
-- Root cause of the bug in 0028:
--   After a song plays, the played row still occupies its original position
--   (played_at IS NOT NULL but the row stays in the table).  When the
--   now-playing item moves forward (e.g., the item that was at position 1
--   is now current), the old code did:
--
--     UPDATE queue SET position = 0 WHERE id = <current_item>
--
--   But position 0 is already taken by the played row, which violates the
--   UNIQUE(player_id, type, position) constraint.
--
-- Fix:
--   Never change the now-playing item's position at all.
--   Instead, randomly redistribute the EXISTING positions occupied by
--   "other" unplayed items among themselves (a bijection over the same set).
--   Because no new position values are introduced, the UNIQUE constraint
--   is never violated — even atomically via a CTE.
--
--   The CTE pattern ensures Postgres reads all old values before writing
--   any new values, so no transient intermediate state can trigger a conflict.

CREATE OR REPLACE FUNCTION queue_shuffle(
  p_player_id UUID,
  p_type      TEXT DEFAULT 'normal'
)
RETURNS void AS $$
DECLARE
  v_current_queue_id UUID;
BEGIN
  -- Same advisory lock used by all queue RPCs — prevents concurrent conflicts.
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));

  -- Find the queue row for the currently playing video.
  -- We join on player_status.current_media_id to identify the active item.
  SELECT q.id INTO v_current_queue_id
  FROM   queue        q
  JOIN   player_status ps
    ON   ps.player_id       = q.player_id
    AND  ps.current_media_id = q.media_item_id
  WHERE  q.player_id  = p_player_id
    AND  q.type       = p_type
    AND  q.played_at IS NULL
  LIMIT  1;

  -- Randomly redistribute the positions that the "other" unplayed items
  -- currently occupy.  We do NOT touch the now-playing item at all — it
  -- keeps whatever position it already has.
  --
  -- How it works:
  --   `others` : each non-current unplayed item gets a random rank
  --   `slots`  : the sorted list of positions those same items occupy
  --   JOIN on rank = slot_rank  →  each item is assigned one of those
  --              existing positions, but in random order
  --   Because the SET of position values never changes, no UNIQUE
  --   violation can occur — not even transiently (CTE atomicity).
  WITH others AS (
    SELECT id,
           ROW_NUMBER() OVER (ORDER BY RANDOM()) AS rand_rank
    FROM   queue
    WHERE  player_id  = p_player_id
      AND  type       = p_type
      AND  played_at IS NULL
      AND  (v_current_queue_id IS NULL OR id != v_current_queue_id)
  ),
  slots AS (
    SELECT position,
           ROW_NUMBER() OVER (ORDER BY position) AS slot_rank
    FROM   queue
    WHERE  player_id  = p_player_id
      AND  type       = p_type
      AND  played_at IS NULL
      AND  (v_current_queue_id IS NULL OR id != v_current_queue_id)
  )
  UPDATE queue q
  SET    position = s.position
  FROM   others o
  JOIN   slots  s ON o.rand_rank = s.slot_rank
  WHERE  q.id = o.id;

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
