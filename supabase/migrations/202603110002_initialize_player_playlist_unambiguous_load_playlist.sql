-- 202603110002_initialize_player_playlist_unambiguous_load_playlist.sql
--
-- Production still reports:
--   function load_playlist(uuid, uuid, integer) is not unique
-- from initialize_player_playlist().
--
-- Even if a legacy 3-arg overload exists, initialize_player_playlist should
-- always target the canonical 4-arg signature explicitly.

DROP FUNCTION IF EXISTS initialize_player_playlist(UUID);

CREATE OR REPLACE FUNCTION initialize_player_playlist(
  p_player_id UUID
)
RETURNS TABLE(success BOOLEAN, playlist_id UUID, playlist_name TEXT, loaded_count INT) AS $$
DECLARE
  v_unplayed_count     INT;
  v_playlist_id        UUID;
  v_playlist_name      TEXT;
  v_loaded_count       INT := 0;
BEGIN
  SELECT COUNT(*) INTO v_unplayed_count
  FROM   queue
  WHERE  player_id = p_player_id
    AND  type      = 'normal'
    AND  played_at IS NULL;

  IF v_unplayed_count > 0 THEN
    RETURN QUERY SELECT TRUE, NULL::UUID, NULL::TEXT, 0;
    RETURN;
  END IF;

  SELECT active_playlist_id INTO v_playlist_id
  FROM   players
  WHERE  id = p_player_id;

  IF v_playlist_id IS NOT NULL THEN
    SELECT name INTO v_playlist_name
    FROM   playlists
    WHERE  id = v_playlist_id;

    IF NOT FOUND THEN
      v_playlist_id := NULL;
    END IF;
  END IF;

  IF v_playlist_id IS NULL THEN
    SELECT p.id, p.name INTO v_playlist_id, v_playlist_name
    FROM   playlists p
    WHERE  EXISTS (SELECT 1 FROM playlist_items pi WHERE pi.playlist_id = p.id)
    ORDER  BY p.created_at DESC
    LIMIT  1;
  END IF;

  IF v_playlist_id IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::UUID, NULL::TEXT, 0;
    RETURN;
  END IF;

  -- Explicit 4-arg call avoids ambiguity with any legacy 3-arg overload.
  SELECT lp.loaded_count INTO v_loaded_count
  FROM   load_playlist(p_player_id, v_playlist_id, 0, FALSE) lp;

  RETURN QUERY SELECT TRUE, v_playlist_id, v_playlist_name, v_loaded_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION initialize_player_playlist(UUID) TO authenticated, service_role;
