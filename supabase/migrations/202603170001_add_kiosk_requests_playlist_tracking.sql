-- Ensure each player has a dedicated "Kiosk Requests" playlist and
-- provide an idempotent helper to append kiosk-requested media.

CREATE OR REPLACE FUNCTION public.provision_kiosk_requests_playlist_for_player(
  p_player_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_playlist_id UUID;
BEGIN
  IF p_player_id IS NULL THEN
    RAISE EXCEPTION 'player_id is required';
  END IF;

  -- Serialize operations per player to avoid duplicate playlist/item races.
  PERFORM pg_advisory_xact_lock(
    hashtext('kiosk_requests_playlist'),
    hashtext(p_player_id::TEXT)
  );

  SELECT id
  INTO v_playlist_id
  FROM public.playlists
  WHERE player_id = p_player_id
    AND LOWER(name) = LOWER('Kiosk Requests')
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_playlist_id IS NULL THEN
    INSERT INTO public.playlists (player_id, name, description, is_active)
    VALUES (
      p_player_id,
      'Kiosk Requests',
      'Automatically tracks kiosk song requests',
      FALSE
    )
    RETURNING id INTO v_playlist_id;
  END IF;

  RETURN v_playlist_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.add_media_to_kiosk_requests_playlist(
  p_session_id UUID,
  p_media_item_id UUID
)
RETURNS TABLE(
  playlist_id UUID,
  item_added BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player_id UUID;
  v_playlist_id UUID;
  v_exists BOOLEAN;
  v_next_position INT;
BEGIN
  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'session_id is required';
  END IF;

  IF p_media_item_id IS NULL THEN
    RAISE EXCEPTION 'media_item_id is required';
  END IF;

  SELECT ks.player_id
  INTO v_player_id
  FROM public.kiosk_sessions ks
  WHERE ks.session_id = p_session_id;

  IF v_player_id IS NULL THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  v_playlist_id := public.provision_kiosk_requests_playlist_for_player(v_player_id);

  SELECT EXISTS (
    SELECT 1
    FROM public.playlist_items pi
    WHERE pi.playlist_id = v_playlist_id
      AND pi.media_item_id = p_media_item_id
  )
  INTO v_exists;

  IF v_exists THEN
    playlist_id := v_playlist_id;
    item_added := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT COALESCE(MAX(pi.position) + 1, 0)
  INTO v_next_position
  FROM public.playlist_items pi
  WHERE pi.playlist_id = v_playlist_id;

  INSERT INTO public.playlist_items (playlist_id, position, media_item_id)
  VALUES (v_playlist_id, v_next_position, p_media_item_id);

  playlist_id := v_playlist_id;
  item_added := TRUE;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.ensure_kiosk_requests_playlist_on_player_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.provision_kiosk_requests_playlist_for_player(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS players_provision_kiosk_requests_playlist ON public.players;

CREATE TRIGGER players_provision_kiosk_requests_playlist
AFTER INSERT ON public.players
FOR EACH ROW
EXECUTE FUNCTION public.ensure_kiosk_requests_playlist_on_player_insert();

-- Backfill for existing players.
INSERT INTO public.playlists (player_id, name, description, is_active)
SELECT
  p.id,
  'Kiosk Requests',
  'Automatically tracks kiosk song requests',
  FALSE
FROM public.players p
WHERE NOT EXISTS (
  SELECT 1
  FROM public.playlists pl
  WHERE pl.player_id = p.id
    AND LOWER(pl.name) = LOWER('Kiosk Requests')
);

GRANT EXECUTE ON FUNCTION public.provision_kiosk_requests_playlist_for_player(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_media_to_kiosk_requests_playlist(UUID, UUID) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ensure_kiosk_requests_playlist_on_player_insert() TO service_role;
