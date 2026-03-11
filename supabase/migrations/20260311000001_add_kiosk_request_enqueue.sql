-- Add atomic kiosk request enqueue function.
-- This was in migrations_backup/0016 but was never applied to the main migrations.
-- Deducts one credit from the kiosk session (unless freeplay) and enqueues the
-- media item as a priority queue entry.

CREATE OR REPLACE FUNCTION kiosk_request_enqueue(
  p_session_id UUID,
  p_media_item_id UUID
) RETURNS UUID AS $$
DECLARE
  v_player_id UUID;
  v_credits INT;
  v_coin_per_song INT := 1;
  v_freeplay BOOLEAN := false;
  v_queue_id UUID;
BEGIN
  -- Lock the kiosk session row to prevent races
  SELECT player_id, credits
  INTO v_player_id, v_credits
  FROM kiosk_sessions
  WHERE session_id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  -- Load player settings
  SELECT freeplay, coin_per_song
  INTO v_freeplay, v_coin_per_song
  FROM player_settings
  WHERE player_id = v_player_id;

  IF v_freeplay IS NULL THEN
    v_freeplay := false;
  END IF;

  IF v_coin_per_song IS NULL THEN
    v_coin_per_song := 1;
  END IF;

  -- Deduct credits only when not freeplay
  IF NOT v_freeplay THEN
    IF v_credits < v_coin_per_song THEN
      RAISE EXCEPTION 'Insufficient credits';
    END IF;

    UPDATE kiosk_sessions
    SET credits = credits - v_coin_per_song
    WHERE session_id = p_session_id;
  END IF;

  -- Enqueue as priority (queue_add handles position locking)
  v_queue_id := queue_add(v_player_id, p_media_item_id, 'priority', p_session_id::text);

  PERFORM log_event(v_player_id, 'kiosk_request_enqueue', 'info', jsonb_build_object(
    'session_id', p_session_id,
    'media_item_id', p_media_item_id,
    'queue_id', v_queue_id
  ));

  RETURN v_queue_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION kiosk_request_enqueue(UUID, UUID) TO authenticated, anon, service_role;
