-- RPC to get all jukeboxes (publicly accessible)
-- Used by the player landing page to show all available jukeboxes

CREATE OR REPLACE FUNCTION public.get_all_jukeboxes()
RETURNS TABLE(
  player_id UUID,
  jukebox_slug TEXT,
  display_name TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.id AS player_id,
    p.jukebox_slug,
    COALESCE(NULLIF(p.display_name, ''), p.name, p.jukebox_slug) AS display_name
  FROM public.players p
  WHERE p.jukebox_slug IS NOT NULL
  ORDER BY p.jukebox_slug;
$$;

GRANT EXECUTE ON FUNCTION public.get_all_jukeboxes() TO anon, authenticated, service_role;
