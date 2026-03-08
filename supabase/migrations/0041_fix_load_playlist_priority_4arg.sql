-- 0041_fix_load_playlist_priority_4arg.sql
--
-- Fix regression introduced by 0040:
--   Migration 0037 replaced the 3-arg load_playlist(UUID,UUID,INT) with a
--   4-arg version load_playlist(UUID,UUID,INT,BOOLEAN) adding p_skip_shuffle.
--   Migration 0040 accidentally recreated the 3-arg signature via
--   CREATE OR REPLACE (PostgreSQL treats different arg counts as distinct
--   overloads, so OR REPLACE did not replace the 4-arg version — it created a
--   new 3-arg sibling).  PostgREST then returned PGRST203 "could not choose
--   best candidate" because both signatures matched a 3-argument call.
--
-- Fix:
--   1. Drop the spurious 3-arg function created by 0040.
--   2. CREATE OR REPLACE the correct 4-arg version with the priority-playing
--      fix from 0040: skip the player_status update when a PRIORITY queue item
--      is currently playing (not just when a normal item is playing).

DROP FUNCTION IF EXISTS load_playlist(UUID, UUID, INT);

CREATE OR REPLACE FUNCTION load_playlist(
  p_player_id    UUID,
  p_playlist_id  UUID,
  p_start_index  INT     DEFAULT 0,
  p_skip_shuffle BOOLEAN DEFAULT FALSE  -- pass TRUE from queue_next loop-refill
)
RETURNS TABLE(loaded_count INT) AS $$
DECLARE
  v_loaded_count          INT := 0;
  v_shuffle               BOOLEAN;
  v_current_normal_id     UUID;
  v_current_normal_pos    INT;
  v_priority_is_playing   BOOLEAN := FALSE;
  v_insert_start_pos      INT;
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
    ON   ps.player_id        = q.player_id
    AND  ps.current_media_id = q.media_item_id
  WHERE  q.player_id = p_player_id
    AND  q.type      = 'normal'
  LIMIT  1;

  -- Check whether a PRIORITY queue item is currently playing.
  -- Same join as above but for type = 'priority'.  When a kiosk request is
  -- mid-play, v_current_normal_id is NULL (priority items are not normal),
  -- but we must still treat the player as "busy" and leave player_status alone.
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

  -- Only update player_status when nothing is currently playing —
  -- neither a normal queue item NOR a priority queue item.
  -- If either is mid-play, leave player_status alone so the player advances
  -- naturally into the new playlist when the current song ends.
  IF v_current_normal_id IS NULL AND NOT v_priority_is_playing THEN
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

  -- Shuffle only on explicit playlist loads, never on loop-refills.
  -- p_skip_shuffle = TRUE is passed by queue_next to suppress this.
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
