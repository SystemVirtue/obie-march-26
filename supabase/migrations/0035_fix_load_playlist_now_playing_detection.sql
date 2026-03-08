-- 0035_fix_load_playlist_now_playing_detection.sql
--
-- Fix: load_playlist incorrectly filters out the currently playing queue item.
--
-- Root cause:
--   queue_next marks the selected item as played (played_at = NOW()) atomically
--   the moment it picks it.  While the song is playing, its queue row already
--   has played_at IS NOT NULL.
--
--   load_playlist (0032) looked for the now-playing item with:
--       AND q.played_at IS NULL
--   This excluded the active item.  With nothing found, load_playlist assumed
--   the player was idle, deleted all normal queue items, inserted the new
--   playlist from position 0, and reset player_status — interrupting the
--   currently playing song.
--
--   Observed in logs as two rapid playlist_loaded events:
--       now_playing_preserved: false  ← first call, finds nothing → resets player
--       now_playing_preserved: true   ← second call (from double-load), finds new
--                                       song (now unplayed), too late
--
-- Fix:
--   Remove the played_at IS NULL filter from the now-playing item lookup.
--   We only need to match player_status.current_media_id to a queue row of
--   type = 'normal'.  The played_at value is irrelevant for this purpose —
--   what matters is whether the media_id in player_status has a queue row.

CREATE OR REPLACE FUNCTION load_playlist(
  p_player_id   UUID,
  p_playlist_id UUID,
  p_start_index INT DEFAULT 0
)
RETURNS TABLE(loaded_count INT) AS $$
DECLARE
  v_loaded_count       INT := 0;
  v_shuffle            BOOLEAN;
  v_current_normal_id  UUID;
  v_current_normal_pos INT;
  v_insert_start_pos   INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));

  SELECT shuffle INTO v_shuffle
  FROM   player_settings
  WHERE  player_id = p_player_id;

  -- Identify the currently playing NORMAL queue item (if any).
  --
  -- IMPORTANT: played_at IS NULL is intentionally NOT filtered here.
  -- queue_next marks the active item as played (played_at = NOW()) the instant
  -- it picks it, so while the song is playing the row already has
  -- played_at IS NOT NULL.  Filtering by played_at IS NULL would miss it,
  -- causing load_playlist to reset player_status and interrupt playback.
  SELECT q.id, q.position
    INTO v_current_normal_id, v_current_normal_pos
  FROM   queue q
  JOIN   player_status ps
    ON   ps.player_id       = q.player_id
    AND  ps.current_media_id = q.media_item_id
  WHERE  q.player_id  = p_player_id
    AND  q.type       = 'normal'
  LIMIT  1;

  -- Clear the normal queue, keeping only the now-playing item (if any).
  DELETE FROM queue
  WHERE  player_id = p_player_id
    AND  type      = 'normal'
    AND  (v_current_normal_id IS NULL OR id != v_current_normal_id);

  -- Insert position: immediately after now-playing, or at 0 if idle.
  v_insert_start_pos := COALESCE(v_current_normal_pos + 1, 0);

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

  -- Only update player_status when nothing is currently playing.
  IF v_current_normal_id IS NULL THEN
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
        state             = 'loading',
        progress          = 0,
        now_playing_index = p_start_index,
        last_updated      = NOW()
      WHERE player_id = p_player_id;
    END IF;
  END IF;

  IF v_shuffle AND v_loaded_count > 1 THEN
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
      'shuffled',              v_shuffle AND v_loaded_count > 1,
      'now_playing_preserved', v_current_normal_id IS NOT NULL
    )
  );

  RETURN QUERY SELECT v_loaded_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION load_playlist(UUID, UUID, INT) TO authenticated, service_role;
