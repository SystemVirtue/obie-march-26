-- 0030_load_playlist_preserve_now_playing.sql
--
-- Fixes load_playlist so that loading a new playlist does NOT interrupt
-- the currently playing song.
--
-- Previous behaviour (0028):
--   DELETE FROM queue WHERE player_id = p_player_id AND type = 'normal';
--   → This killed the now-playing item mid-song, causing an audible cut-out.
--   → player_status was always overwritten, forcing the player to start
--     loading the first track of the new playlist immediately.
--
-- New behaviour:
--   1.  Find the currently playing NORMAL queue item (if any).
--   2.  DELETE all normal items EXCEPT that one.
--   3.  INSERT new playlist items starting at the position immediately after
--       the current item — so they queue up as "Up Next".
--   4.  Update active_playlist_id on the players row.
--   5.  Update player_status ONLY if nothing is currently playing.
--       If a song is mid-play, leave player_status alone — the player will
--       advance naturally into the new playlist when the song ends.
--   6.  If shuffle is enabled, call queue_shuffle (0029) which already
--       protects the now-playing item and only reorders positions after it.
--
-- Additionally, "Shuffle on Load" is now documented to mean:
--   "Randomly reorder the Up Next positions when a new playlist is loaded."
-- It is NOT triggered by video-load events (that was removed in 0028 on the
-- player side).  The player_settings.shuffle column name is unchanged.

CREATE OR REPLACE FUNCTION load_playlist(
  p_player_id   UUID,
  p_playlist_id UUID,
  p_start_index INT DEFAULT 0
)
RETURNS TABLE(loaded_count INT) AS $$
DECLARE
  v_loaded_count       INT := 0;
  v_shuffle            BOOLEAN;
  v_current_normal_id  UUID;   -- queue.id of the now-playing normal item
  v_current_normal_pos INT;    -- queue.position of that item
  v_insert_start_pos   INT;    -- position to assign to the first new item
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));

  -- Read the shuffle setting once.
  SELECT shuffle INTO v_shuffle
  FROM   player_settings
  WHERE  player_id = p_player_id;

  -- Find the currently playing NORMAL queue item (if any).
  -- We match via player_status.current_media_id so this is reliable even
  -- when the item is not at position 0 (because earlier items have been played).
  SELECT q.id, q.position
    INTO v_current_normal_id, v_current_normal_pos
  FROM   queue q
  JOIN   player_status ps
    ON   ps.player_id       = q.player_id
    AND  ps.current_media_id = q.media_item_id
  WHERE  q.player_id  = p_player_id
    AND  q.type       = 'normal'
    AND  q.played_at IS NULL
  LIMIT  1;

  -- Clear the normal queue, preserving only the currently playing item.
  -- This removes played history rows AND all unplayed Up Next items from the
  -- old playlist, while leaving the active song untouched.
  DELETE FROM queue
  WHERE  player_id = p_player_id
    AND  type      = 'normal'
    AND  (v_current_normal_id IS NULL OR id != v_current_normal_id);

  -- Determine the insertion start position:
  --   • Playing: insert immediately after the current item's position.
  --   • Idle: start at position 0.
  v_insert_start_pos := COALESCE(v_current_normal_pos + 1, 0);

  -- Insert playlist items in their defined order.
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

  -- Update the player's active playlist reference.
  UPDATE players
  SET    active_playlist_id = p_playlist_id,
         updated_at         = NOW()
  WHERE  id = p_player_id;

  -- Update player_status only when nothing is currently playing.
  -- If a song is mid-play, leave player_status alone — the song continues
  -- to completion and the player naturally advances into the new playlist.
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

  -- "Shuffle Playlist when loaded": if enabled, randomly reorder the newly
  -- inserted Up Next items.  queue_shuffle (0029) protects the now-playing
  -- item automatically — only positions after it are reshuffled.
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
