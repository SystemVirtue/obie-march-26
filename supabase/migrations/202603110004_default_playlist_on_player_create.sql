-- 202603110004_default_playlist_on_player_create.sql
--
-- Ensures every newly created player gets a copy of the DJAMMS default playlist
-- and marks it as the active playlist.

CREATE OR REPLACE FUNCTION public.provision_default_playlist_for_player(
  p_player_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_playlist_id UUID;
  v_template_playlist_id UUID;
  v_new_playlist_id UUID;
  v_template_description TEXT;
BEGIN
  -- If this player already has a DJAMMS default playlist variant, activate it.
  SELECT id
  INTO v_existing_playlist_id
  FROM public.playlists
  WHERE player_id = p_player_id
    AND LOWER(name) IN ('djamms default playlist', 'djammms default playlist')
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_existing_playlist_id IS NOT NULL THEN
    UPDATE public.playlists
    SET is_active = (id = v_existing_playlist_id)
    WHERE player_id = p_player_id;

    UPDATE public.players
    SET active_playlist_id = v_existing_playlist_id,
        updated_at = NOW()
    WHERE id = p_player_id;

    RETURN v_existing_playlist_id;
  END IF;

  -- Prefer an existing DJAMMS (or historical DJAMMMS) playlist with items as template.
  SELECT p.id, p.description
  INTO v_template_playlist_id, v_template_description
  FROM public.playlists p
  WHERE LOWER(p.name) IN ('djamms default playlist', 'djammms default playlist')
    AND EXISTS (
      SELECT 1
      FROM public.playlist_items pi
      WHERE pi.playlist_id = p.id
    )
  ORDER BY
    CASE
      WHEN LOWER(p.name) = 'djamms default playlist' THEN 0
      WHEN LOWER(p.name) = 'djammms default playlist' THEN 1
      ELSE 2
    END,
    p.created_at ASC
  LIMIT 1;

  -- Fallback to default player's active/non-empty playlist if explicit DJAMMS template is absent.
  IF v_template_playlist_id IS NULL THEN
    SELECT p.id, p.description
    INTO v_template_playlist_id, v_template_description
    FROM public.playlists p
    WHERE p.player_id = '00000000-0000-0000-0000-000000000001'
      AND EXISTS (
        SELECT 1
        FROM public.playlist_items pi
        WHERE pi.playlist_id = p.id
      )
    ORDER BY
      CASE WHEN p.is_active THEN 0 ELSE 1 END,
      p.created_at ASC
    LIMIT 1;
  END IF;

  IF v_template_playlist_id IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.playlists (player_id, name, description, is_active)
  VALUES (
    p_player_id,
    'DJAMMS Default Playlist',
    v_template_description,
    TRUE
  )
  RETURNING id INTO v_new_playlist_id;

  INSERT INTO public.playlist_items (playlist_id, position, media_item_id)
  SELECT
    v_new_playlist_id,
    ROW_NUMBER() OVER (ORDER BY pi.position, pi.id) - 1,
    pi.media_item_id
  FROM public.playlist_items pi
  WHERE pi.playlist_id = v_template_playlist_id;

  UPDATE public.playlists
  SET is_active = (id = v_new_playlist_id)
  WHERE player_id = p_player_id;

  UPDATE public.players
  SET active_playlist_id = v_new_playlist_id,
      updated_at = NOW()
  WHERE id = p_player_id;

  PERFORM public.log_event(
    p_player_id,
    'default_playlist_provisioned',
    'info',
    jsonb_build_object(
      'playlist_id', v_new_playlist_id,
      'template_playlist_id', v_template_playlist_id,
      'name', 'DJAMMS Default Playlist'
    )
  );

  RETURN v_new_playlist_id;
END;
$$;

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
  ON CONFLICT (player_id) DO NOTHING;

  INSERT INTO public.player_settings (player_id, branding)
  VALUES (
    v_player_id,
    jsonb_build_object('name', v_display, 'logo', '', 'theme', 'dark')
  )
  ON CONFLICT (player_id) DO NOTHING;

  INSERT INTO public.player_memberships (player_id, user_id, role)
  VALUES (v_player_id, v_user_id, 'owner')
  ON CONFLICT (player_id, user_id)
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

CREATE OR REPLACE FUNCTION public.create_player_for_user(p_user_id UUID, p_email TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player_id UUID;
  v_name TEXT;
  v_base_slug TEXT;
  v_slug TEXT;
  v_n INT := 1;
BEGIN
  v_name := split_part(p_email, '@', 1) || '''s Jukebox';
  v_base_slug := public.normalize_jukebox_slug(split_part(p_email, '@', 1));
  IF v_base_slug = '' THEN
    v_base_slug := 'JUKEBOX';
  END IF;

  v_slug := v_base_slug;
  WHILE EXISTS (SELECT 1 FROM public.players WHERE jukebox_slug = v_slug) LOOP
    v_slug := v_base_slug || '_' || v_n::TEXT;
    v_n := v_n + 1;
  END LOOP;

  INSERT INTO public.players (name, display_name, jukebox_slug, status, owner_id)
  VALUES (v_name, v_name, v_slug, 'offline', p_user_id)
  RETURNING id INTO v_player_id;

  INSERT INTO public.player_status (player_id, state)
  VALUES (v_player_id, 'idle');

  INSERT INTO public.player_settings (player_id, branding)
  VALUES (v_player_id, jsonb_build_object('name', v_name, 'logo', '', 'theme', 'dark'));

  INSERT INTO public.player_memberships (player_id, user_id, role)
  VALUES (v_player_id, p_user_id, 'owner')
  ON CONFLICT (player_id, user_id)
  DO UPDATE SET role = 'owner', updated_at = NOW();

  PERFORM public.provision_default_playlist_for_player(v_player_id);

  BEGIN
    PERFORM public.log_event(
      v_player_id,
      'player_created',
      'info',
      jsonb_build_object('owner', p_user_id, 'email', p_email, 'slug', v_slug)
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'log_event failed during user provisioning for %: %', p_user_id, SQLERRM;
  END;

  RETURN v_player_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.provision_default_playlist_for_player(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_jukebox(TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_player_for_user(UUID, TEXT) TO service_role;
