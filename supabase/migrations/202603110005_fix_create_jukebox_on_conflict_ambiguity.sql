-- Fix create_jukebox ambiguity: RETURNS TABLE(player_id, ...) creates output
-- variables that collide with column names in ON CONFLICT (player_id, ...).
-- Use named constraints so Postgres does not resolve those identifiers as
-- PL/pgSQL variables.

CREATE OR REPLACE FUNCTION public.create_jukebox(
  p_slug TEXT,
  p_display_name TEXT DEFAULT NULL
)
RETURNS TABLE(
  player_id UUID,
  jukebox_slug TEXT,
  display_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_slug TEXT;
  v_display TEXT;
  v_player_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  v_slug := public.normalize_jukebox_slug(p_slug);
  IF v_slug = '' THEN
    RAISE EXCEPTION 'Jukebox name is required';
  END IF;

  IF v_slug !~ '^[A-Z0-9_-]+$' THEN
    RAISE EXCEPTION 'Jukebox name must be A-Z, 0-9, underscore, or dash';
  END IF;

  v_display := COALESCE(NULLIF(TRIM(p_display_name), ''), v_slug);

  INSERT INTO public.players (name, display_name, jukebox_slug, status, owner_id)
  VALUES (v_display, v_display, v_slug, 'offline', v_user_id)
  RETURNING id INTO v_player_id;

  INSERT INTO public.player_status (player_id, state)
  VALUES (v_player_id, 'idle')
  ON CONFLICT ON CONSTRAINT player_status_pkey DO NOTHING;

  INSERT INTO public.player_settings (player_id, branding)
  VALUES (
    v_player_id,
    jsonb_build_object('name', v_display, 'logo', '', 'theme', 'dark')
  )
  ON CONFLICT ON CONSTRAINT player_settings_pkey DO NOTHING;

  INSERT INTO public.player_memberships (player_id, user_id, role)
  VALUES (v_player_id, v_user_id, 'owner')
  ON CONFLICT ON CONSTRAINT player_memberships_pkey
  DO UPDATE SET role = 'owner', updated_at = NOW();

  PERFORM public.provision_default_playlist_for_player(v_player_id);

  PERFORM public.log_event(
    v_player_id,
    'player_created',
    'info',
    jsonb_build_object('owner', v_user_id, 'slug', v_slug)
  );

  RETURN QUERY
  SELECT v_player_id, v_slug, v_display;
END;
$$;