-- =============================================================================
-- Fix: load_playlist does not update player_status.source / local_url
--
-- ROOT CAUSE (James Blunt freeze, 2026-04-09):
--   After a Cloudflare/R2 video plays, player_status.source = 'cloudflare'.
--   When load_playlist fires (admin playlist load, loop refill, init), it
--   updates current_media_id, state, progress, now_playing_index — but NOT
--   source or local_url.
--
--   The stale source='cloudflare' causes the client-side recovery timeouts
--   to be SKIPPED (App.tsx line ~1294: "skip YouTube loading/pause timeouts").
--   If the subsequent YouTube video's ended call fails (502, network error,
--   edge-function timeout), there is NO recovery path — the player freezes
--   indefinitely because:
--     1. YouTube fires no more events (video already ended)
--     2. Loading timeout skipped (source='cloudflare')
--     3. REST polling fallback only runs during 'loading' state
--
--   queue_next already sets source/local_url correctly (since migration
--   20260307000003).  load_playlist was missed.
--
-- FIX:
--   Rewrite the player_status UPDATE inside load_playlist to also set
--   source and local_url based on the next media item's source_type,
--   using the same CASE pattern as queue_next.
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
  v_current_normal_id     UUID;
  v_current_normal_pos    INT;
  v_priority_is_playing   BOOLEAN := FALSE;
  v_insert_start_pos      INT;
  v_next_media_id         UUID;
  v_next_source_type      TEXT;
  v_next_url              TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));

  SELECT shuffle INTO v_shuffle
  FROM   player_settings
  WHERE  player_id = p_player_id;

  -- Identify the currently playing NORMAL queue item (if any).
  -- Since queue_next now DELETEs items when played, this JOIN will only
  -- find an item if load_playlist is called while a song is mid-play AND
  -- the item hasn't been deleted yet (e.g. explicit admin playlist load).
  SELECT q.id, q.position
    INTO v_current_normal_id, v_current_normal_pos
  FROM   queue q
  JOIN   player_status ps
    ON   ps.player_id        = q.player_id
    AND  ps.current_media_id = q.media_item_id
  WHERE  q.player_id = p_player_id
    AND  q.type      = 'normal'
  LIMIT  1;

  SELECT EXISTS (
    SELECT 1
    FROM   queue q
    JOIN   player_status ps
      ON   ps.player_id        = q.player_id
      AND  ps.current_media_id = q.media_item_id
    WHERE  q.player_id = p_player_id
      AND  q.type      = 'priority'
  ) INTO v_priority_is_playing;

  -- Clear the normal queue, keeping only the now-playing normal item (if any).
  DELETE FROM queue
  WHERE  player_id = p_player_id
    AND  type      = 'normal'
    AND  (v_current_normal_id IS NULL OR id != v_current_normal_id);

  v_insert_start_pos := COALESCE(v_current_normal_pos + 1, 0);

  -- Insert playlist items with expires_at = NULL.
  -- Playlist items must persist until played — they should NEVER auto-expire.
  INSERT INTO queue (player_id, type, media_item_id, position, requested_by, expires_at)
  SELECT
    p_player_id,
    'normal',
    pi.media_item_id,
    v_insert_start_pos + (ROW_NUMBER() OVER (ORDER BY pi.position) - 1),
    'playlist',
    NULL  -- no expiry for playlist items
  FROM   playlist_items pi
  WHERE  pi.playlist_id = p_playlist_id
  ORDER  BY pi.position;

  GET DIAGNOSTICS v_loaded_count = ROW_COUNT;

  UPDATE players
  SET    active_playlist_id = p_playlist_id,
         updated_at         = NOW()
  WHERE  id = p_player_id;

  IF v_current_normal_id IS NULL AND NOT v_priority_is_playing THEN
    IF v_loaded_count > 0
       OR EXISTS (
         SELECT 1 FROM queue
         WHERE  player_id = p_player_id AND type = 'priority' AND played_at IS NULL
       )
    THEN
      -- Resolve the next media item's source_type so we can set
      -- player_status.source and local_url correctly.
      -- Without this, source stays stale from the previous video,
      -- which can disable client-side recovery timeouts.
      SELECT q.media_item_id, mi.source_type, mi.url
        INTO v_next_media_id, v_next_source_type, v_next_url
      FROM   queue q
      JOIN   media_items mi ON mi.id = q.media_item_id
      WHERE  q.player_id = p_player_id
        AND  q.played_at IS NULL
      ORDER  BY CASE WHEN q.type = 'priority' THEN 0 ELSE 1 END,
                q.position ASC
      LIMIT  1;

      UPDATE player_status
      SET
        current_media_id  = v_next_media_id,
        state             = 'loading',
        progress          = 0,
        now_playing_index = p_start_index,
        source            = CASE
          WHEN v_next_source_type = 'cloudflare' THEN 'cloudflare'
          ELSE 'youtube'
        END,
        local_url         = CASE
          WHEN v_next_source_type = 'cloudflare' THEN v_next_url
          ELSE NULL
        END,
        last_updated      = NOW()
      WHERE player_id = p_player_id;
    END IF;
  END IF;

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
      'now_playing_preserved', v_current_normal_id IS NOT NULL OR v_priority_is_playing
    )
  );

  RETURN QUERY SELECT v_loaded_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION load_playlist(UUID, UUID, INT, BOOLEAN) TO authenticated, service_role;
