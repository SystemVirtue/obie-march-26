-- 0028_fix_queue_shuffle_and_load_playlist.sql
--
-- Two fixes:
--
-- 1. queue_shuffle: must NEVER move the currently playing item (position 0).
--    The previous version shuffled ALL unplayed normal items, which could
--    randomly reassign the now-playing video to a new position, causing the
--    next queue_next call to pick a different video unexpectedly.
--    Fix: look up player_status.current_media_id, pin that queue row to
--    position 0, then shuffle all OTHER items into positions 1, 2, 3, ...
--
-- 2. load_playlist: must NOT do its own internal RANDOM() shuffle.
--    The previous version randomised the INSERT order so a random playlist
--    item ended up at position 0 (Now Playing). That violates the rule that
--    "Now Playing is always position 0 of the ordered playlist".
--    Fix: always insert in playlist order (positions 0, 1, 2, ...), set
--    position 0 as current_media_id, THEN call queue_shuffle if the
--    player's shuffle setting is enabled.  queue_shuffle will protect
--    position 0 and randomise positions 1+.
--
--    Note: load_playlist already holds pg_advisory_xact_lock for this
--    player.  queue_shuffle acquires the same lock — this is safe because
--    pg_advisory_xact_lock is reentrant within the same transaction.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1.  queue_shuffle — protect position 0 (Now Playing)
-- ─────────────────────────────────────────────────────────────────────────────

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

  -- Find the queue row for the currently playing video so we can protect it.
  -- We join on player_status.current_media_id to identify the active item.
  SELECT q.id INTO v_current_queue_id
  FROM   queue        q
  JOIN   player_status ps
    ON   ps.player_id      = q.player_id
    AND  ps.current_media_id = q.media_item_id
  WHERE  q.player_id  = p_player_id
    AND  q.type       = p_type
    AND  q.played_at IS NULL
  LIMIT  1;

  -- Ensure the currently playing item is pinned at position 0.
  IF v_current_queue_id IS NOT NULL THEN
    UPDATE queue SET position = 0 WHERE id = v_current_queue_id;
  END IF;

  -- Randomly reorder every OTHER unplayed item in this type bucket,
  -- assigning positions 1, 2, 3, ... (never 0).
  -- The CTE computes all new positions before any UPDATE fires, so the
  -- UNIQUE(player_id, type, position) constraint is never transiently violated.
  WITH shuffled AS (
    SELECT
      id,
      ROW_NUMBER() OVER (ORDER BY RANDOM()) AS new_pos  -- 1-based
    FROM  queue
    WHERE player_id  = p_player_id
      AND type       = p_type
      AND played_at IS NULL
      AND (v_current_queue_id IS NULL OR id != v_current_queue_id)
  )
  UPDATE queue q
  SET    position = s.new_pos
  FROM   shuffled s
  WHERE  q.id = s.id;

  PERFORM log_event(
    p_player_id,
    'queue_shuffle',
    'info',
    jsonb_build_object(
      'type', p_type,
      'now_playing_protected', v_current_queue_id IS NOT NULL
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION queue_shuffle(UUID, TEXT) TO authenticated, service_role;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2.  load_playlist — insert in order, then call queue_shuffle if enabled
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION load_playlist(
  p_player_id   UUID,
  p_playlist_id UUID,
  p_start_index INT DEFAULT 0
)
RETURNS TABLE(loaded_count INT) AS $$
DECLARE
  v_loaded_count INT := 0;
  v_shuffle      BOOLEAN;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));

  -- Read the shuffle setting once.
  SELECT shuffle INTO v_shuffle
  FROM   player_settings
  WHERE  player_id = p_player_id;

  -- Clear existing normal queue (priority queue is preserved).
  DELETE FROM queue
  WHERE  player_id = p_player_id
    AND  type      = 'normal';

  -- Insert playlist items in their defined order: position 0, 1, 2, ...
  -- Position 0 is always the first item from the playlist — it will become
  -- Now Playing.  Shuffle (if enabled) randomises positions 1+ afterwards.
  INSERT INTO queue (player_id, type, media_item_id, position, requested_by)
  SELECT
    p_player_id,
    'normal',
    pi.media_item_id,
    (ROW_NUMBER() OVER (ORDER BY pi.position) - 1)::int,
    'playlist'
  FROM   playlist_items pi
  WHERE  pi.playlist_id = p_playlist_id
  ORDER  BY pi.position;

  GET DIAGNOSTICS v_loaded_count = ROW_COUNT;

  -- Update the player's active playlist reference.
  UPDATE players
  SET    active_playlist_id = p_playlist_id,
         updated_at         = NOW()
  WHERE  id = p_player_id;

  -- Set the first unplayed item as current_media_id.
  -- Priority items always take precedence over normal queue.
  IF v_loaded_count > 0
     OR EXISTS (
       SELECT 1 FROM queue
       WHERE  player_id = p_player_id AND type = 'priority' AND played_at IS NULL
     )
  THEN
    UPDATE player_status
    SET
      current_media_id = (
        SELECT media_item_id
        FROM   queue
        WHERE  player_id = p_player_id
          AND  played_at IS NULL
        ORDER  BY CASE WHEN type = 'priority' THEN 0 ELSE 1 END,
                  position ASC
        LIMIT  1
      ),
      state            = 'loading',
      progress         = 0,
      now_playing_index = CASE
        WHEN EXISTS (
          SELECT 1 FROM queue
          WHERE player_id = p_player_id AND type = 'priority' AND played_at IS NULL
        ) THEN now_playing_index
        ELSE p_start_index
      END,
      last_updated     = NOW()
    WHERE player_id = p_player_id;
  END IF;

  -- If shuffle is enabled, randomise positions 1+ now that current_media_id
  -- is set.  queue_shuffle will detect the now-playing item (position 0) via
  -- player_status.current_media_id and pin it — only the Up Next items move.
  IF v_shuffle AND v_loaded_count > 1 THEN
    PERFORM queue_shuffle(p_player_id, 'normal');
  END IF;

  PERFORM log_event(
    p_player_id,
    'playlist_loaded',
    'info',
    jsonb_build_object(
      'playlist_id',   p_playlist_id,
      'start_index',   p_start_index,
      'loaded_count',  v_loaded_count,
      'shuffled',      v_shuffle AND v_loaded_count > 1
    )
  );

  RETURN QUERY SELECT v_loaded_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION load_playlist(UUID, UUID, INT) TO authenticated, service_role;
