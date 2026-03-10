-- Fix playlist loading to prioritize priority queue items over normal queue items
-- When loading a playlist, if priority items exist, they should be set as current instead of normal items

CREATE OR REPLACE FUNCTION load_playlist(
  p_player_id UUID,
  p_playlist_id UUID,
  p_start_index INT DEFAULT 0
)
RETURNS TABLE(loaded_count INT) AS $$
DECLARE
  v_loaded_count INT := 0;
  v_item RECORD;
  v_position INT := 0;
  v_shuffle BOOLEAN;
BEGIN
  -- Acquire lock
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));

  -- Check shuffle setting
  SELECT shuffle INTO v_shuffle FROM player_settings WHERE player_id = p_player_id;

  -- Clear existing normal queue (keep priority queue)
  DELETE FROM queue
  WHERE player_id = p_player_id
    AND type = 'normal';

  -- Insert items into queue with sequential positions
  FOR v_item IN
    SELECT pi.media_item_id, pi.position
    FROM playlist_items pi
    WHERE pi.playlist_id = p_playlist_id
    ORDER BY
      CASE WHEN v_shuffle THEN RANDOM() ELSE
        ((pi.position + (SELECT COALESCE(MAX(position) + 1, 1) FROM playlist_items WHERE playlist_id = p_playlist_id) - p_start_index)
         % (SELECT COALESCE(MAX(position) + 1, 1) FROM playlist_items WHERE playlist_id = p_playlist_id))::float
      END
  LOOP
    INSERT INTO queue (player_id, type, media_item_id, position, requested_by)
    VALUES (p_player_id, 'normal', v_item.media_item_id, v_position, 'playlist');

    v_position := v_position + 1;
    v_loaded_count := v_loaded_count + 1;
  END LOOP;

  -- Update player's active playlist
  UPDATE players
  SET
    active_playlist_id = p_playlist_id,
    updated_at = NOW()
  WHERE id = p_player_id;

  -- If queue has items, set first as current (priority first, then normal)
  IF v_loaded_count > 0 OR EXISTS (SELECT 1 FROM queue WHERE player_id = p_player_id AND type = 'priority' AND played_at IS NULL) THEN
    UPDATE player_status ps
    SET
      current_media_id = (
        SELECT media_item_id
        FROM queue
        WHERE player_id = p_player_id
          AND played_at IS NULL
        ORDER BY
          CASE WHEN type = 'priority' THEN 0 ELSE 1 END,
          position ASC
        LIMIT 1
      ),
      state = 'loading',
      progress = 0,
      now_playing_index = CASE
        WHEN EXISTS (SELECT 1 FROM queue WHERE player_id = p_player_id AND type = 'priority' AND played_at IS NULL) THEN now_playing_index
        ELSE p_start_index
      END,
      last_updated = NOW()
    WHERE ps.player_id = p_player_id;
  END IF;

  -- Log event
  PERFORM log_event(p_player_id, 'playlist_loaded', 'info', jsonb_build_object(
    'playlist_id', p_playlist_id,
    'start_index', p_start_index,
    'loaded_count', v_loaded_count,
    'shuffled', v_shuffle
  ));

  RETURN QUERY SELECT v_loaded_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Fix queue_next to always prioritize priority items, then play normal items sequentially by position (shuffle only affects loading)
CREATE OR REPLACE FUNCTION queue_next(
  p_player_id UUID
)
RETURNS TABLE(media_item_id UUID, title TEXT, url TEXT, duration INT) AS $$
DECLARE
  v_next_queue_item RECORD;
BEGIN
  -- Acquire lock
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));

  -- Always prioritize priority items first
  IF EXISTS (SELECT 1 FROM queue WHERE player_id = p_player_id AND type = 'priority' AND played_at IS NULL) THEN
    -- Priority items exist - pick the first one
    SELECT q.id, q.media_item_id, q.type INTO v_next_queue_item
    FROM queue q
    WHERE q.player_id = p_player_id
      AND q.type = 'priority'
      AND q.played_at IS NULL
    ORDER BY q.position ASC
    LIMIT 1;
  ELSE
    -- No priority items - pick the first normal item by position
    SELECT q.id, q.media_item_id, q.type INTO v_next_queue_item
    FROM queue q
    WHERE q.player_id = p_player_id
      AND q.type = 'normal'
      AND q.played_at IS NULL
    ORDER BY q.position ASC
    LIMIT 1;
  END IF;

  IF v_next_queue_item IS NULL THEN
    -- No items in queue
    RETURN QUERY
    SELECT NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::INT
    WHERE FALSE;
    RETURN;
  END IF;

  -- Mark as played
  UPDATE queue
  SET played_at = NOW()
  WHERE id = v_next_queue_item.id;

  -- Update player status and advance now_playing_index for normal queue items
  UPDATE player_status
  SET
    current_media_id = v_next_queue_item.media_item_id,
    state = 'loading',
    progress = 0,
    now_playing_index = CASE
      WHEN v_next_queue_item.type = 'normal' THEN COALESCE(now_playing_index, 0) + 1
      ELSE now_playing_index
    END,
    last_updated = NOW()
  WHERE player_id = p_player_id;

  -- Log event
  PERFORM log_event(p_player_id, 'queue_next', 'info', jsonb_build_object(
    'media_item_id', v_next_queue_item.media_item_id,
    'type', v_next_queue_item.type
  ));

  -- Return media details
  RETURN QUERY
  SELECT m.id, m.title, m.url, m.duration
  FROM media_items m
  WHERE m.id = v_next_queue_item.media_item_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;