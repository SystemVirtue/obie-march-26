-- =============================================================================
-- Fix load_playlist: NEVER overwrite queue position 0
--
-- Problem: When loading a playlist, position 0 (the now_playing/next item)
-- was being overwritten if the currently-playing detection failed or if the
-- player had just started.
--
-- Fix: Position 0 is now SACRED - load_playlist will NEVER touch it.
--   - Delete only positions 1+ (not position 0)
--   - Insert new items starting at position 1 (not position 0)
--   - Position 0 continues playing naturally, then the new playlist follows
-- =============================================================================

CREATE OR REPLACE FUNCTION load_playlist(
  p_player_id    UUID,
  p_playlist_id  UUID,
  p_start_index  INT     DEFAULT 0,
  p_skip_shuffle BOOLEAN DEFAULT FALSE
)
RETURNS TABLE(loaded_count INT) AS $$
DECLARE
  v_loaded_count          INT := 0;
  v_shuffle               BOOLEAN;
  v_position_0_id         UUID;    -- queue.id of the item at position 0 (NEVER TOUCH THIS)
  v_insert_start_pos      INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));

  SELECT shuffle INTO v_shuffle
  FROM   player_settings
  WHERE  player_id = p_player_id;

  -- Capture the sacred position 0 item (if any).
  -- Position 0 is NEVER deleted or overwritten by playlist loading.
  -- It will play to completion, then the new playlist follows naturally.
  SELECT q.id INTO v_position_0_id
  FROM   queue q
  WHERE  q.player_id = p_player_id
    AND  q.type      = 'normal'
    AND  q.position  = 0
  LIMIT  1;

  -- Clear the normal queue, BUT NEVER TOUCH POSITION 0.
  -- Delete everything at position >= 1, plus any items that aren't position 0.
  DELETE FROM queue
  WHERE  player_id = p_player_id
    AND  type      = 'normal'
    AND  position  >= 1;

  -- Insert position: start at position 1 normally, BUT if position 0 is empty,
  -- start at position 0 so the first playlist item plays immediately.
  v_insert_start_pos := CASE WHEN v_position_0_id IS NULL THEN 0 ELSE 1 END;

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

  -- Only update player_status when nothing is at position 0.
  -- If position 0 has content, leave player_status alone - it will play
  -- to completion and then advance into the new playlist naturally.
  IF v_position_0_id IS NULL THEN
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
      'playlist_id',           p_playlist_id,
      'start_index',           p_start_index,
      'loaded_count',          v_loaded_count,
      'shuffled',              v_shuffle AND v_loaded_count > 1 AND NOT p_skip_shuffle,
      'position_0_preserved',  v_position_0_id IS NOT NULL
    )
  );

  RETURN QUERY SELECT v_loaded_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION load_playlist(UUID, UUID, INT, BOOLEAN) TO authenticated, service_role;
