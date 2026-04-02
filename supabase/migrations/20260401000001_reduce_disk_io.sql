-- =============================================================================
-- Reduce Disk IO
--
-- Four targeted fixes for the Disk IO budget exhaustion alert:
--
--   1. queue_next: DELETE played items instead of UPDATE played_at.
--      The partial indexes (WHERE played_at IS NULL) caused every queue
--      advance to generate non-HOT heap writes + index condition changes,
--      producing ~5x the WAL of a HOT update.  History is preserved in
--      system_logs via log_event('queue_next').
--
--   2. Replace partial queue indexes with non-partial equivalents.
--      Now that played items are deleted the partial WHERE is unnecessary.
--
--   3. Add missing FK indexes on players (flagged by performance advisor).
--
--   4. Drop unused index on playlists (flagged by performance advisor).
-- =============================================================================

-- ── Fix 1: queue_next — DELETE instead of UPDATE played_at ──────────────────

-- Remove the legacy 1-arg overload; the 2-arg version with DEFAULT NULL
-- handles both call sites (player-control and queue-manager edge functions).
DROP FUNCTION IF EXISTS public.queue_next(UUID);

CREATE OR REPLACE FUNCTION public.queue_next(
  p_player_id         UUID,
  p_expected_media_id UUID DEFAULT NULL
)
RETURNS TABLE(media_item_id UUID, title TEXT, url TEXT, duration INT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_next_queue_item    RECORD;
  v_loop               BOOLEAN;
  v_active_playlist_id UUID;
  v_loaded_count       INT;
  v_media              RECORD;
  v_current_media_id   UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));

  -- ── Idempotency guard ──────────────────────────────────────────────────────
  -- If the caller tells us which media_id it thinks is currently playing,
  -- verify the DB agrees.  A mismatch means another queue_next already
  -- advanced the queue — return empty to prevent a double-skip.
  IF p_expected_media_id IS NOT NULL THEN
    SELECT ps.current_media_id INTO v_current_media_id
    FROM   player_status ps
    WHERE  ps.player_id = p_player_id;

    IF v_current_media_id IS DISTINCT FROM p_expected_media_id THEN
      PERFORM log_event(
        p_player_id,
        'queue_next_skipped',
        'warn',
        jsonb_build_object(
          'reason',            'idempotency_guard',
          'expected_media_id', p_expected_media_id,
          'actual_media_id',   v_current_media_id
        )
      );
      RETURN QUERY SELECT NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::INT WHERE FALSE;
      RETURN;
    END IF;
  END IF;

  -- Priority items first (played_at IS NULL condition removed — items are
  -- deleted when played so all rows in queue are unplayed).
  IF EXISTS (
    SELECT 1 FROM queue
    WHERE player_id = p_player_id AND type = 'priority'
  ) THEN
    SELECT q.id, q.media_item_id, q.type INTO v_next_queue_item
    FROM   queue q
    WHERE  q.player_id = p_player_id AND q.type = 'priority'
    ORDER  BY q.position ASC
    LIMIT  1;
  ELSE
    SELECT q.id, q.media_item_id, q.type INTO v_next_queue_item
    FROM   queue q
    WHERE  q.player_id = p_player_id AND q.type = 'normal'
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
          WHERE  q.player_id = p_player_id AND q.type = 'normal'
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

  -- Delete the item (was: UPDATE queue SET played_at = NOW()).
  -- Deleting avoids the partial-index condition change that blocked HOT updates
  -- and generated excess WAL on every queue advance.
  DELETE FROM queue WHERE id = v_next_queue_item.id;

  -- Fetch the media item to determine source type.
  SELECT m.id, m.source_type, m.url, m.title, m.duration
    INTO v_media
  FROM   media_items m
  WHERE  m.id = v_next_queue_item.media_item_id;

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
$$;

GRANT EXECUTE ON FUNCTION public.queue_next(UUID, UUID) TO authenticated, service_role;

-- ── Fix 2: Replace partial queue indexes ────────────────────────────────────
-- Clean up any rows that were previously marked played_at (shouldn't be any
-- in normal operation, but guards against constraint violations on the new
-- non-partial unique index).
DELETE FROM public.queue WHERE played_at IS NOT NULL;

-- Drop partial indexes and replace with non-partial equivalents.
DROP INDEX IF EXISTS public.queue_player_type_pos_uniq;
CREATE UNIQUE INDEX queue_player_type_pos_uniq
  ON public.queue (player_id, type, position);

DROP INDEX IF EXISTS public.idx_queue_expires;
CREATE INDEX idx_queue_expires
  ON public.queue (expires_at);

-- ── Fix 3: Missing FK indexes (Supabase performance advisor) ────────────────
CREATE INDEX IF NOT EXISTS idx_players_owner_id
  ON public.players (owner_id);

CREATE INDEX IF NOT EXISTS idx_players_priority_player_id
  ON public.players (priority_player_id);

-- ── Fix 4: Unused index (Supabase performance advisor) ──────────────────────
DROP INDEX IF EXISTS public.idx_playlists_player_id;
