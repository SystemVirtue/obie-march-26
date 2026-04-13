-- =============================================================================
-- Optimize queue_next: reduce redundant queries
--
-- 1. Consolidate priority/normal item selection into a single query
--    (was: EXISTS check + separate SELECT = 2 index scans → now 1)
-- 2. Eliminate double media_items fetch (was: SELECT INTO v_media + RETURN QUERY
--    SELECT from media_items again → now uses v_media directly for RETURN)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.queue_next(
  p_player_id         UUID,
  p_expected_media_id UUID DEFAULT NULL
)
RETURNS TABLE(media_item_id UUID, title TEXT, url TEXT, duration INT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next_queue_item    RECORD;
  v_loop               BOOLEAN;
  v_active_playlist_id UUID;
  v_loaded_count       INT;
  v_media              RECORD;
  v_current_media_id   UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));

  -- Idempotency guard: if caller says what's playing, verify the DB agrees.
  -- Mismatch means another queue_next already ran — return empty to prevent double-skip.
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
      RETURN;
    END IF;
  END IF;

  -- Single query: priority items sort before normal items.
  -- The (type = 'normal')::int expression yields 0 for 'priority' and 1 for 'normal',
  -- so priority items are selected first. Within each type, lowest position wins.
  SELECT q.id, q.media_item_id, q.type INTO v_next_queue_item
  FROM   queue q
  WHERE  q.player_id = p_player_id
  ORDER  BY (q.type = 'normal')::int, q.position ASC
  LIMIT  1;

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
      RETURN;
    END IF;
  END IF;

  -- DELETE the consumed item.
  DELETE FROM queue WHERE id = v_next_queue_item.id;

  -- Fetch media item once (was fetched twice before this optimization).
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

  -- Return from the already-fetched v_media record (no second media_items query).
  RETURN QUERY
  SELECT v_media.id, v_media.title, v_media.url, v_media.duration;
END;
$$;

GRANT EXECUTE ON FUNCTION public.queue_next(UUID, UUID) TO authenticated, service_role;
