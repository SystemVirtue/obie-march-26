-- =============================================================================
-- Fix load_playlist: use player_status to detect active playback
--
-- Problem: load_playlist checked for a queue row at position=0 to decide
-- whether something was currently playing. But queue_next DELETES the playing
-- item from the queue, so:
--   - Actively playing video: NO row in queue (was deleted by queue_next)
--   - "Up next" video: row at position 0 (shifted down from position 1)
--
-- When the queue was empty (only one item was queued, it was consumed), there
-- was no row at position 0. load_playlist then inserted the new playlist
-- starting at position 0 AND overwrote player_status with state='loading',
-- interrupting the currently playing video mid-song.
--
-- Fix: check player_status.current_media_id IS NOT NULL to determine if a
-- video is actively playing. Only fall back to queue position 0 check for
-- the "up next" slot guard. Never update player_status unless both checks
-- confirm the player is truly idle.
-- =============================================================================

CREATE OR REPLACE FUNCTION load_playlist(
  p_player_id    UUID,
  p_playlist_id  UUID,
  p_start_index  INT     DEFAULT 0,
  p_skip_shuffle BOOLEAN DEFAULT FALSE
)
RETURNS TABLE(loaded_count INT) AS $$
DECLARE
  v_loaded_count           INT := 0;
  v_shuffle                BOOLEAN;
  v_currently_playing_id   UUID;   -- non-NULL means a video is actively playing
  v_position_0_id          UUID;   -- non-NULL means an "up next" item occupies slot 0
  v_insert_start_pos       INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));

  SELECT shuffle INTO v_shuffle
  FROM   player_settings
  WHERE  player_id = p_player_id;

  -- Check player_status for an actively playing video.
  -- The playing video's queue row is DELETED by queue_next, so the queue
  -- itself may be empty even while a video is mid-playback. We must check
  -- player_status directly.
  SELECT ps.current_media_id INTO v_currently_playing_id
  FROM   player_status ps
  WHERE  ps.player_id = p_player_id
    AND  ps.current_media_id IS NOT NULL
    AND  ps.state NOT IN ('idle', 'error');

  -- Also check the "up next" slot (position 0 in the queue).
  -- If occupied, the new playlist must start at position 1 so this
  -- queued item still plays next before the playlist begins.
  SELECT q.id INTO v_position_0_id
  FROM   queue q
  WHERE  q.player_id = p_player_id
    AND  q.type      = 'normal'
    AND  q.position  = 0
  LIMIT  1;

  -- Delete everything at position 1+ (never touch the "up next" at position 0).
  DELETE FROM queue
  WHERE  player_id = p_player_id
    AND  type      = 'normal'
    AND  position  >= 1;

  -- Insertion start position logic:
  --   • Something is playing → start at 1 (don't interrupt current video)
  --   • "Up next" slot occupied → start at 1 (preserve the queued item)
  --   • Truly idle (nothing playing, queue empty) → start at 0 (play immediately)
  v_insert_start_pos := CASE
    WHEN v_currently_playing_id IS NOT NULL THEN 1
    WHEN v_position_0_id        IS NOT NULL THEN 1
    ELSE 0
  END;

  INSERT INTO queue (player_id, type, media_item_id, position, requested_by)
  SELECT
    p_player_id,
    'normal',
    pi.media_item_id,
    v_insert_start_pos + (ROW_NUMBER() OVER (ORDER BY pi.position) - 1),
    'playlist'
  FROM   playlist_items pi
  WHERE  pi.playlist_id = p_playlist_id
  ORDER  BY pi.position;

  GET DIAGNOSTICS v_loaded_count = ROW_COUNT;

  UPDATE players
  SET    active_playlist_id = p_playlist_id,
         updated_at         = NOW()
  WHERE  id = p_player_id;

  -- Only update player_status when nothing is playing AND queue was empty.
  -- If anything is in-flight, leave player_status untouched — the current
  -- video will finish naturally and the new playlist will follow.
  IF v_currently_playing_id IS NULL AND v_position_0_id IS NULL THEN
    IF v_loaded_count > 0
       OR EXISTS (
         SELECT 1 FROM queue
         WHERE  player_id = p_player_id AND type = 'priority'
       )
    THEN
      UPDATE player_status
      SET
        current_media_id = (
          SELECT media_item_id
          FROM   queue
          WHERE  player_id = p_player_id
          ORDER  BY CASE WHEN type = 'priority' THEN 0 ELSE 1 END,
                    position ASC
          LIMIT  1
        ),
        state             = 'loading',
        progress          = 0,
        now_playing_index = p_start_index,
        last_updated      = NOW()
      WHERE player_id = p_player_id;
    END IF;
  END IF;

  -- Shuffle only on explicit playlist loads, never on loop-refills.
  IF v_shuffle AND v_loaded_count > 1 AND NOT p_skip_shuffle THEN
    PERFORM queue_shuffle(p_player_id, 'normal');
  END IF;

  PERFORM log_event(
    p_player_id,
    'playlist_loaded',
    'info',
    jsonb_build_object(
      'playlist_id',            p_playlist_id,
      'start_index',            p_start_index,
      'loaded_count',           v_loaded_count,
      'shuffled',               v_shuffle AND v_loaded_count > 1 AND NOT p_skip_shuffle,
      'currently_playing_id',   v_currently_playing_id,
      'position_0_preserved',   v_position_0_id IS NOT NULL,
      'insert_start_pos',       v_insert_start_pos
    )
  );

  RETURN QUERY SELECT v_loaded_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION load_playlist(UUID, UUID, INT, BOOLEAN) TO authenticated, service_role;
