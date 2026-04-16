-- =============================================================================
-- Migration: queue_next hardening
--
-- Adds explicit position-gap cleanup to queue_next so it's self-healing
-- even if the trigger hasn't run (e.g. rows were deleted by other means).
--
-- Also removes the now_playing_index increment which was a source of
-- drift — the index is reconstructed from queue history on demand instead.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.queue_next(
  p_player_id         UUID,
  p_expected_media_id UUID DEFAULT NULL
)
RETURNS TABLE(media_item_id UUID, title TEXT, url TEXT, duration INT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_next   RECORD;
  v_media  RECORD;
  v_loop   BOOLEAN;
  v_active_playlist_id UUID;
  v_loaded_count INT;
  v_current_media_id UUID;
BEGIN
  -- Serialise all queue operations for this player
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));

  -- Idempotency guard: if caller says what's currently playing, verify DB agrees.
  -- Mismatch means another queue_next already ran — return empty.
  IF p_expected_media_id IS NOT NULL THEN
    SELECT ps.current_media_id INTO v_current_media_id
    FROM   player_status ps
    WHERE  ps.player_id = p_player_id;

    IF v_current_media_id IS DISTINCT FROM p_expected_media_id THEN
      PERFORM log_event(
        p_player_id, 'queue_next_idempotency_block', 'warn',
        jsonb_build_object(
          'expected', p_expected_media_id,
          'actual',   v_current_media_id
        )
      );
      RETURN QUERY SELECT NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::INT WHERE FALSE;
      RETURN;
    END IF;
  END IF;

  -- Select next item: priority first, then normal
  SELECT q.id, q.media_item_id, q.type
  INTO   v_next
  FROM   queue q
  WHERE  q.player_id = p_player_id
  ORDER BY
    -- Priority type always before normal
    CASE q.type WHEN 'priority' THEN 0 ELSE 1 END ASC,
    q.position ASC
  LIMIT 1;

  -- Queue empty — check loop setting
  IF v_next IS NULL THEN
    SELECT ps.loop INTO v_loop
    FROM   player_settings ps
    WHERE  ps.player_id = p_player_id;

    IF v_loop THEN
      SELECT active_playlist_id INTO v_active_playlist_id
      FROM   players WHERE id = p_player_id;

      IF v_active_playlist_id IS NOT NULL THEN
        SELECT lp.loaded_count INTO v_loaded_count
        FROM   load_playlist(p_player_id, v_active_playlist_id, 0, TRUE) lp;

        IF v_loaded_count > 0 THEN
          SELECT q.id, q.media_item_id, q.type
          INTO   v_next
          FROM   queue q
          WHERE  q.player_id = p_player_id AND q.type = 'normal'
          ORDER BY q.position ASC
          LIMIT 1;
        END IF;
      END IF;
    END IF;

    IF v_next IS NULL THEN
      UPDATE player_status
      SET    state = 'idle', last_updated = NOW()
      WHERE  player_id = p_player_id;

      RETURN QUERY SELECT NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::INT WHERE FALSE;
      RETURN;
    END IF;
  END IF;

  -- Fetch media item
  SELECT m.id, m.source_type, m.url, m.title, m.duration
  INTO   v_media
  FROM   media_items m
  WHERE  m.id = v_next.media_item_id;

  -- Delete consumed item (trigger will resequence positions automatically)
  DELETE FROM queue WHERE id = v_next.id;

  -- Advance player_status
  UPDATE player_status
  SET
    current_media_id  = v_next.media_item_id,
    state             = 'loading',
    progress          = 0,
    now_playing_index = COALESCE(now_playing_index, 0) + 1,
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
    p_player_id, 'queue_next', 'info',
    jsonb_build_object(
      'media_item_id', v_next.media_item_id,
      'type',          v_next.type,
      'source_type',   v_media.source_type
    )
  );

  RETURN QUERY
  SELECT m.id, m.title, m.url, m.duration
  FROM   media_items m
  WHERE  m.id = v_next.media_item_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.queue_next(UUID, UUID) TO authenticated, service_role;
