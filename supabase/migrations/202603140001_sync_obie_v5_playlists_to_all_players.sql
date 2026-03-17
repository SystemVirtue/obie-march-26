-- 202603140001_sync_obie_v5_playlists_to_all_players.sql
--
-- Ensure the imported obie-v5 playlists are available to:
-- 1) all existing players (one-time backfill)
-- 2) every newly created player (trigger on players insert)

CREATE OR REPLACE FUNCTION public.sync_obie_v5_playlists_to_player(p_player_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_source_player_id UUID := '00000000-0000-0000-0000-000000000001';
  v_shared_names TEXT[] := ARRAY[
    'DJAMMMS Default Playlist',
    'Karaoke',
    'Obie #1',
    'Obie #2',
    'Obie #3',
    'Obie #4',
    'Obie #5',
    'Obie Jo',
    'Obie Johno',
    'Obie Nights',
    'Obie Playlist',
    'Poly'
  ];
BEGIN
  IF p_player_id IS NULL THEN
    RETURN;
  END IF;

  -- Ensure playlist rows exist by name for the target player.
  INSERT INTO public.playlists (player_id, name, description, is_active)
  SELECT p_player_id, sp.name, sp.description, FALSE
  FROM public.playlists sp
  WHERE sp.player_id = v_source_player_id
    AND sp.name = ANY(v_shared_names)
    AND NOT EXISTS (
      SELECT 1
      FROM public.playlists tp
      WHERE tp.player_id = p_player_id
        AND tp.name = sp.name
    );

  -- Rebuild playlist items so target always matches the canonical source set.
  DELETE FROM public.playlist_items pi
  USING public.playlists tp
  WHERE pi.playlist_id = tp.id
    AND tp.player_id = p_player_id
    AND tp.name = ANY(v_shared_names);

  INSERT INTO public.playlist_items (playlist_id, media_item_id, position)
  SELECT tp.id, spi.media_item_id, spi.position
  FROM public.playlists sp
  JOIN public.playlist_items spi
    ON spi.playlist_id = sp.id
  JOIN public.playlists tp
    ON tp.player_id = p_player_id
   AND tp.name = sp.name
  WHERE sp.player_id = v_source_player_id
    AND sp.name = ANY(v_shared_names)
  ORDER BY tp.id, spi.position;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_sync_obie_v5_playlists_on_player_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.sync_obie_v5_playlists_to_player(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_obie_v5_playlists_on_player_insert ON public.players;

CREATE TRIGGER trg_sync_obie_v5_playlists_on_player_insert
AFTER INSERT ON public.players
FOR EACH ROW
EXECUTE FUNCTION public.trg_sync_obie_v5_playlists_on_player_insert();

GRANT EXECUTE ON FUNCTION public.sync_obie_v5_playlists_to_player(UUID) TO authenticated, service_role;

-- Backfill all existing players now.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT id FROM public.players LOOP
    PERFORM public.sync_obie_v5_playlists_to_player(r.id);
  END LOOP;
END;
$$;
