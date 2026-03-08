-- 0037_fix_loop_no_reshuffle.sql
--
-- Fix: "Shuffle on Load" fires randomly during playback when Loop is enabled.
--
-- Root cause:
--   queue_next (0032) calls load_playlist when the queue is exhausted and
--   loop = true.  load_playlist always calls queue_shuffle when
--   player_settings.shuffle = true.  This causes the Up Next queue to be
--   randomly reshuffled every time the playlist loops — not just when the
--   admin explicitly loads a new playlist.
--
-- Fix:
--   Add p_skip_shuffle BOOLEAN DEFAULT FALSE to load_playlist.
--   - FALSE (default): shuffle based on player_settings.shuffle — used by
--     explicit playlist loads from the admin and initialize_player_playlist.
--   - TRUE: never shuffle — used by queue_next loop-refill so the
--     queue order is preserved across loop boundaries.
--
--   queue_next is updated to pass p_skip_shuffle := TRUE on loop-refill.
--
-- Note: PostgreSQL does not allow CREATE OR REPLACE to change the number of
-- parameters on an existing function, so load_playlist must be dropped and
-- recreated.  The existing 3-arg callers (playlist-manager edge function,
-- initialize_player_playlist) continue to work because PostgreSQL resolves
-- the 3-arg call against the new 4-arg signature using the 4th default.
-- ─────────────────────────────────────────────────────────────────────────────


-- 1.  load_playlist — add p_skip_shuffle parameter
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS load_playlist(UUID, UUID, INT);

CREATE OR REPLACE FUNCTION load_playlist(
  p_player_id    UUID,
  p_playlist_id  UUID,
  p_start_index  INT     DEFAULT 0,
  p_skip_shuffle BOOLEAN DEFAULT FALSE  -- pass TRUE from queue_next loop-refill
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
      'now_playing_preserved', v_current_normal_id IS NOT NULL
    )
  );

  RETURN QUERY SELECT v_loaded_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION load_playlist(UUID, UUID, INT, BOOLEAN) TO authenticated, service_role;


-- 2.  queue_next — pass p_skip_shuffle := TRUE on loop-refill
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION queue_next(
  p_player_id UUID
)
RETURNS TABLE(media_item_id UUID, title TEXT, url TEXT, duration INT) AS $$
DECLARE
  v_next_queue_item    RECORD;
  v_loop               BOOLEAN;
  v_active_playlist_id UUID;
  v_loaded_count       INT;
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
        -- Reload playlist WITHOUT shuffle.  Shuffle on Load applies only to
        -- explicit loads from the admin, not to automatic loop-refills.
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

    -- Still nothing (loop=false or no playlist) — return empty.
    IF v_next_queue_item IS NULL THEN
      RETURN QUERY SELECT NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::INT WHERE FALSE;
      RETURN;
    END IF;
  END IF;

  -- Mark item as played.
  UPDATE queue SET played_at = NOW() WHERE id = v_next_queue_item.id;

  -- Advance player_status.
  UPDATE player_status
  SET
    current_media_id  = v_next_queue_item.media_item_id,
    state             = 'loading',
    progress          = 0,
    now_playing_index = CASE
      WHEN v_next_queue_item.type = 'normal' THEN COALESCE(now_playing_index, 0) + 1
      ELSE now_playing_index
    END,
    last_updated      = NOW()
  WHERE player_id = p_player_id;

  PERFORM log_event(
    p_player_id,
    'queue_next',
    'info',
    jsonb_build_object(
      'media_item_id', v_next_queue_item.media_item_id,
      'type',          v_next_queue_item.type
    )
  );

  RETURN QUERY
  SELECT m.id, m.title, m.url, m.duration
  FROM   media_items m
  WHERE  m.id = v_next_queue_item.media_item_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION queue_next(UUID) TO authenticated, service_role;
