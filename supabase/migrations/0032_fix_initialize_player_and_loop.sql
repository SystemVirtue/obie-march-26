-- 0032_fix_initialize_player_and_loop.sql
--
-- Three related fixes for "playlist resets to original order every dozen songs" bug.
--
-- ── Root cause A: initialize_player_playlist fires unconditionally ────────────
--   Called on every player mount/reconnect, it always calls load_playlist, which
--   clears and reloads the entire Up Next queue — destroying shuffle order and
--   causing 2-4 concurrent playlist_loaded events when multiple browser tabs open.
--
--   Fix: Skip the load entirely when unplayed normal items already exist in the
--   queue.  Only load when the queue is genuinely empty (first start, or all
--   songs exhausted).
--
-- ── Root cause B: loop feature has no server-side implementation ──────────────
--   player_settings.loop = true is saved but nothing reads it.  When the queue
--   runs dry, playback stops silently.
--
--   Fix: Add loop logic to queue_next.  When no unplayed items remain AND
--   loop = true, reload the active playlist and return the first new item.
--   This keeps the player running continuously without any client involvement.
--
-- ── Root cause C: migration 20251109233222 overwrites load_playlist from 0030 ──
--   Lexicographically '0030...' < '20251109...' so on a fresh DB the timestamp
--   migration applies last, reverting the now-playing preservation fix in 0030.
--
--   Fix: Re-apply the correct load_playlist definition here, after all timestamp
--   migrations, so it is always the live version regardless of DB init order.
--
-- ─────────────────────────────────────────────────────────────────────────────


-- 1.  Correct load_playlist — re-apply 0030's now-playing-preserving version
-- ─────────────────────────────────────────────────────────────────────────────
--   Identical to 0030.  Repeated here so fresh-DB setups get the right version
--   even after 20251109233222 overwrites it.

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

  -- Clear the normal queue, keeping only the now-playing item.
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


-- 2.  queue_next — add loop support
-- ─────────────────────────────────────────────────────────────────────────────
--   When no unplayed items remain and player_settings.loop = true, reload the
--   active playlist and return its first track.  The reload is done under the
--   same advisory lock already held, so no concurrent modification is possible.
--
--   DROP first because the existing DB version may have a different OUT-parameter
--   signature (SQLSTATE 42P13 prevents CREATE OR REPLACE changing return types).

DROP FUNCTION IF EXISTS queue_next(UUID);

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
        -- Reload playlist under the lock already held (pg_advisory_xact_lock is reentrant).
        SELECT lp.loaded_count INTO v_loaded_count
        FROM   load_playlist(p_player_id, v_active_playlist_id, 0) lp;

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


-- 3.  initialize_player_playlist — conditional load
-- ─────────────────────────────────────────────────────────────────────────────
--   Only loads the default playlist when the normal queue is genuinely empty.
--   If unplayed items already exist (player reconnecting mid-session, multiple
--   tabs, etc.) the call is a no-op — queue state and shuffle order are preserved.

DROP FUNCTION IF EXISTS initialize_player_playlist(UUID);

CREATE OR REPLACE FUNCTION initialize_player_playlist(
  p_player_id UUID
)
RETURNS TABLE(success BOOLEAN, playlist_id UUID, playlist_name TEXT, loaded_count INT) AS $$
DECLARE
  v_unplayed_count     INT;
  v_playlist_id        UUID;
  v_playlist_name      TEXT;
  v_loaded_count       INT := 0;
BEGIN
  -- If unplayed normal items exist, do nothing.  This prevents concurrent
  -- reloads from multiple browser tabs and preserves shuffle order on reconnect.
  SELECT COUNT(*) INTO v_unplayed_count
  FROM   queue
  WHERE  player_id = p_player_id
    AND  type      = 'normal'
    AND  played_at IS NULL;

  IF v_unplayed_count > 0 THEN
    RETURN QUERY SELECT TRUE, NULL::UUID, NULL::TEXT, 0;
    RETURN;
  END IF;

  -- Queue is empty.  Find the active (or any available) playlist.
  SELECT active_playlist_id INTO v_playlist_id
  FROM   players
  WHERE  id = p_player_id;

  IF v_playlist_id IS NOT NULL THEN
    SELECT name INTO v_playlist_name
    FROM   playlists
    WHERE  id = v_playlist_id;

    IF NOT FOUND THEN
      v_playlist_id := NULL; -- playlist was deleted
    END IF;
  END IF;

  -- Fall back to any playlist with items if active one is unavailable.
  IF v_playlist_id IS NULL THEN
    SELECT p.id, p.name INTO v_playlist_id, v_playlist_name
    FROM   playlists p
    WHERE  EXISTS (SELECT 1 FROM playlist_items pi WHERE pi.playlist_id = p.id)
    ORDER  BY p.created_at DESC
    LIMIT  1;
  END IF;

  IF v_playlist_id IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TEXT, 0;
    RETURN;
  END IF;

  SELECT lp.loaded_count INTO v_loaded_count
  FROM   load_playlist(p_player_id, v_playlist_id, 0) lp;

  RETURN QUERY SELECT TRUE, v_playlist_id, v_playlist_name, v_loaded_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION initialize_player_playlist(UUID) TO authenticated, service_role;
