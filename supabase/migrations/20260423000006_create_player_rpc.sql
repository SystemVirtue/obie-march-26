-- Migration: Create RPC function for creating a new player
-- This function handles player creation with proper type safety
CREATE OR REPLACE FUNCTION create_player(p_name TEXT, p_jukebox_slug TEXT) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE v_new_player RECORD;
BEGIN -- Create new player
INSERT INTO players (name, status, jukebox_slug, last_refresh)
VALUES (p_name, 'online', p_jukebox_slug, NOW())
RETURNING * INTO v_new_player;
RETURN json_build_object(
    'id',
    v_new_player.id,
    'name',
    v_new_player.name,
    'jukebox_slug',
    v_new_player.jukebox_slug,
    'status',
    v_new_player.status
);
END;
$$;
-- Add comment for documentation
COMMENT ON FUNCTION create_player IS 'Creates a new player instance with the given name and jukebox slug. Returns the created player data as JSON.';