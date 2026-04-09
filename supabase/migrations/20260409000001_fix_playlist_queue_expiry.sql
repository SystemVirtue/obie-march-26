-- =============================================================================
-- Fix: Playlist queue items expiring after 30 minutes
--
-- ROOT CAUSE:
--   The queue table's expires_at column has a DEFAULT of NOW() + 30 minutes
--   (from 0001_initial_schema.sql).  This was designed for kiosk priority
--   requests that should auto-expire if never served.
--
--   However, load_playlist's INSERT does not specify expires_at, so every
--   playlist item inherits the 30-minute default.  The heartbeat cleanup
--   (player_heartbeat → DELETE WHERE expires_at < NOW()) then wipes the
--   entire normal queue ~30 minutes after a playlist load.  queue_next sees
--   an empty queue, triggers the loop refill, and playback jumps back to
--   the first song — the "Tiffany / I Think We're Alone Now" bug.
--
-- FIX:
--   1. load_playlist: explicitly set expires_at = NULL on inserted items.
--   2. queue_next loop-refill: already calls load_playlist, inherits fix.
--   3. Change column DEFAULT to NULL — playlist and admin items should NOT
--      expire.  Kiosk requests (kiosk_request_enqueue → queue_add) now
--      explicitly set the 30-minute expiry.
--   4. Null out expires_at on any existing playlist items in the queue.
-- =============================================================================

-- ── 1. Remove the 30-minute column default ─────────────────────────────────
ALTER TABLE public.queue ALTER COLUMN expires_at SET DEFAULT NULL;

-- ── 2. Fix load_playlist — set expires_at = NULL explicitly ─────────────────
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
  -- The column default is NOW()+30min (for kiosk items), but playlist items
  -- must persist until played — they should NEVER auto-expire.
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

-- ── 3. Fix queue_add — explicitly set expires_at for priority (kiosk) items ──
-- Kiosk requests SHOULD expire after 30 minutes if never played, so we set
-- the expiry explicitly rather than relying on the (now-removed) column default.
CREATE OR REPLACE FUNCTION queue_add(
  p_player_id    UUID,
  p_media_item_id UUID,
  p_type         TEXT DEFAULT 'normal',
  p_requested_by TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_next_pos INT;
  v_queue_id UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));

  SELECT COALESCE(MAX(position), -1) + 1 INTO v_next_pos
  FROM   queue
  WHERE  player_id = p_player_id
    AND  type      = p_type;

  INSERT INTO queue (player_id, type, media_item_id, position, requested_by, expires_at)
  VALUES (
    p_player_id,
    p_type,
    p_media_item_id,
    v_next_pos,
    p_requested_by,
    CASE WHEN p_type = 'priority' THEN NOW() + INTERVAL '30 minutes' ELSE NULL END
  )
  RETURNING id INTO v_queue_id;

  RETURN v_queue_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION queue_add(UUID, UUID, TEXT, TEXT) TO authenticated, service_role;

-- ── 4. Fix existing queue items — null out expires_at for playlist items ──────
UPDATE public.queue
SET    expires_at = NULL
WHERE  requested_by = 'playlist'
  AND  expires_at IS NOT NULL;

-- Also null out expires_at for any admin-added items (they shouldn't expire)
UPDATE public.queue
SET    expires_at = NULL
WHERE  requested_by = 'admin'
  AND  expires_at IS NOT NULL;
