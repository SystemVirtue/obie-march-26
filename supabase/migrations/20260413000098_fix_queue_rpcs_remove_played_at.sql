-- =============================================================================
-- Fix queue RPCs that still reference played_at column
--
-- Since migration 20260409000001, queue_next DELETEs played items instead of
-- marking played_at = NOW(). All rows in the queue table are unplayed, making
-- every `played_at IS NULL` filter a no-op. These filters must be removed
-- BEFORE migration 20260413000099 drops the played_at column, or the RPCs
-- will throw "column does not exist" errors at runtime.
--
-- Functions updated:
--   queue_add    — remove played_at filters from count + position queries;
--                  preserve max_queue_size enforcement + log_event;
--                  add expires_at for priority items (30-minute expiry)
--   queue_remove — remove played_at filter from item lookup guard
--   queue_clear  — remove played_at filters from DELETE statements
-- =============================================================================

-- ── 1. queue_add ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.queue_add(
  p_player_id     UUID,
  p_media_item_id UUID,
  p_type          TEXT DEFAULT 'normal',
  p_requested_by  TEXT DEFAULT 'admin'
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_queue_id       UUID;
  v_next_position  INT;
  v_max_size       INT;
  v_current_count  INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));

  -- Check queue limits (max_queue_size from player_settings)
  SELECT max_queue_size INTO v_max_size
  FROM   player_settings
  WHERE  player_id = p_player_id;

  SELECT COUNT(*) INTO v_current_count
  FROM   queue
  WHERE  player_id = p_player_id;

  IF v_current_count >= v_max_size THEN
    RAISE EXCEPTION 'Queue is full (max: %)', v_max_size;
  END IF;

  -- Get next position within this type
  SELECT COALESCE(MAX(position) + 1, 0) INTO v_next_position
  FROM   queue
  WHERE  player_id = p_player_id AND type = p_type;

  -- Insert queue item (priority items get 30-minute expiry)
  INSERT INTO queue (player_id, media_item_id, type, position, requested_by, expires_at)
  VALUES (
    p_player_id,
    p_media_item_id,
    p_type,
    v_next_position,
    p_requested_by,
    CASE WHEN p_type = 'priority' THEN NOW() + INTERVAL '30 minutes' ELSE NULL END
  )
  RETURNING id INTO v_queue_id;

  PERFORM log_event(p_player_id, 'queue_add', 'info', jsonb_build_object(
    'queue_id', v_queue_id,
    'type',     p_type,
    'position', v_next_position
  ));

  RETURN v_queue_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.queue_add(UUID, UUID, TEXT, TEXT) TO authenticated, service_role;

-- ── 2. queue_remove ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.queue_remove(
  p_queue_id UUID
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player_id UUID;
  v_type      TEXT;
BEGIN
  SELECT player_id, type INTO v_player_id, v_type
  FROM   queue
  WHERE  id = p_queue_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Queue item not found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('queue_' || v_player_id::text));

  DELETE FROM queue WHERE id = p_queue_id;

  PERFORM log_event(
    v_player_id,
    'queue_remove',
    'info',
    jsonb_build_object('queue_id', p_queue_id, 'type', v_type)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.queue_remove(UUID) TO authenticated, service_role;

-- ── 3. queue_clear ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.queue_clear(
  p_player_id UUID,
  p_type      TEXT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));

  IF p_type IS NULL THEN
    DELETE FROM queue WHERE player_id = p_player_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSE
    DELETE FROM queue WHERE player_id = p_player_id AND type = p_type;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;

  PERFORM log_event(p_player_id, 'queue_clear', 'info', jsonb_build_object('count', v_count, 'type', p_type));
END;
$$;

GRANT EXECUTE ON FUNCTION public.queue_clear(UUID, TEXT) TO authenticated, service_role;
