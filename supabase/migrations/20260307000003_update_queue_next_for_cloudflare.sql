-- Update queue_next to set player_status.source and local_url when the
-- next media item is a cloudflare source, so the player app can switch
-- to the <video> element automatically.

CREATE OR REPLACE FUNCTION queue_next(
  p_player_id UUID
)
RETURNS TABLE(media_item_id UUID, title TEXT, url TEXT, duration INT) AS $$
DECLARE
  v_next_queue_item    RECORD;
  v_loop               BOOLEAN;
  v_active_playlist_id UUID;
  v_loaded_count       INT;
  v_media              RECORD;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));

  -- Priority items first.
  IF EXISTS (
    SELECT 1 FROM queue
    WHERE player_id = p_player_id AND type = 'priority' AND played_at IS NULL
  ) THEN
    SELECT q.id, q.media_item_id, q.type INTO v_next_queue_item
    FROM   queue q
    WHERE  q.player_id = p_player_id AND q.type = 'priority' AND q.played_at IS NULL
    ORDER  BY q.position ASC
    LIMIT  1;
  ELSE
    SELECT q.id, q.media_item_id, q.type INTO v_next_queue_item
    FROM   queue q
    WHERE  q.player_id = p_player_id AND q.type = 'normal' AND q.played_at IS NULL
    ORDER  BY q.position ASC
    LIMIT  1;
  END IF;

  -- Queue exhausted — check loop setting.
  IF v_next_queue_item IS NULL THEN
    SELECT ps.loop INTO v_loop
    FROM   player_settings ps
    WHERE  ps.player_id = p_player_id;

    IF v_loop THEN
      SELECT active_playlist_id INTO v_active_playlist_id
      FROM   players
      WHERE  id = p_player_id;

      IF v_active_playlist_id IS NOT NULL THEN
        SELECT lp.loaded_count INTO v_loaded_count
        FROM   load_playlist(p_player_id, v_active_playlist_id, 0, TRUE) lp;

        IF v_loaded_count > 0 THEN
          SELECT q.id, q.media_item_id, q.type INTO v_next_queue_item
          FROM   queue q
          WHERE  q.player_id = p_player_id AND q.type = 'normal' AND q.played_at IS NULL
          ORDER  BY q.position ASC
          LIMIT  1;
        END IF;
      END IF;
    END IF;

    -- Still nothing — return empty.
    IF v_next_queue_item IS NULL THEN
      RETURN QUERY SELECT NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::INT WHERE FALSE;
      RETURN;
    END IF;
  END IF;

  -- Mark item as played.
  UPDATE queue SET played_at = NOW() WHERE id = v_next_queue_item.id;

  -- Fetch the media item to determine source type.
  SELECT m.id, m.source_type, m.url, m.title, m.duration
    INTO v_media
  FROM   media_items m
  WHERE  m.id = v_next_queue_item.media_item_id;

  -- Advance player_status, setting source/local_url based on media source_type.
  UPDATE player_status
  SET
    current_media_id  = v_next_queue_item.media_item_id,
    state             = 'loading',
    progress          = 0,
    now_playing_index = CASE
      WHEN v_next_queue_item.type = 'normal' THEN COALESCE(now_playing_index, 0) + 1
      ELSE now_playing_index
    END,
    source            = CASE
      WHEN v_media.source_type = 'cloudflare' THEN 'cloudflare'
      ELSE 'youtube'
    END,
    local_url         = CASE
      WHEN v_media.source_type = 'cloudflare' THEN v_media.url
      ELSE NULL
    END,
    last_updated      = NOW()
  WHERE player_id = p_player_id;

  PERFORM log_event(
    p_player_id,
    'queue_next',
    'info',
    jsonb_build_object(
      'media_item_id', v_next_queue_item.media_item_id,
      'type',          v_next_queue_item.type,
      'source_type',   v_media.source_type
    )
  );

  RETURN QUERY
  SELECT m.id, m.title, m.url, m.duration
  FROM   media_items m
  WHERE  m.id = v_next_queue_item.media_item_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION queue_next(UUID) TO authenticated, service_role;
