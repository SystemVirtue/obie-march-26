-- Migration: Create RPC functions for player management
-- These functions support the new PLAYER INSTANCES admin view

-- 1. Reorder players by priority
CREATE OR REPLACE FUNCTION reorder_players(p_player_ids UUID[], p_priorities INT[])
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    i INT;
BEGIN
    -- Validate input arrays match
    IF array_length(p_player_ids, 1) != array_length(p_priorities, 1) THEN
        RETURN json_build_object(
            'status', 'error',
            'reason', 'array_length_mismatch'
        );
    END IF;

    -- Update each player's priority
    FOR i IN 1..array_length(p_player_ids, 1) LOOP
        UPDATE players
        SET priority = p_priorities[i]
        WHERE id = p_player_ids[i];
    END LOOP;

    RETURN json_build_object(
        'status', 'success',
        'updated_count', array_length(p_player_ids, 1)
    );
END;
$$;

-- 2. Delete a player instance
CREATE OR REPLACE FUNCTION delete_player_instance(p_player_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    player_name TEXT;
BEGIN
    -- Get player name for logging
    SELECT COALESCE(player_name_tag, name || ' (' || id::text || ')') INTO player_name
    FROM players
    WHERE id = p_player_id;

    -- Delete player (CASCADE will delete related records)
    DELETE FROM players WHERE id = p_player_id;

    -- Log the deletion
    INSERT INTO event_log (event_type, player_id, payload)
    VALUES (
        'player_instance_deleted',
        p_player_id,
        jsonb_build_object('player_name', player_name)
    );

    RETURN json_build_object(
        'status', 'success',
        'deleted_player_id', p_player_id,
        'player_name', player_name
    );
END;
$$;

-- 3. Trigger identify overlay on player
CREATE OR REPLACE FUNCTION identify_player(p_player_id UUID, p_display_name TEXT DEFAULT NULL)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    player_name TEXT;
BEGIN
    -- Get player name
    SELECT COALESCE(p_display_name, player_name_tag, name || ' (' || id::text || ')') INTO player_name
    FROM players
    WHERE id = p_player_id;

    -- Insert identify command into event_log
    -- The player's realtime subscription will pick this up and display the overlay
    INSERT INTO event_log (event_type, player_id, payload)
    VALUES (
        'identify_player',
        p_player_id,
        jsonb_build_object('display_name', player_name, 'timestamp', NOW())
    );

    RETURN json_build_object(
        'status', 'success',
        'player_id', p_player_id,
        'display_name', player_name
    );
END;
$$;

-- 4. Delete inactive players (offline > 60 seconds)
CREATE OR REPLACE FUNCTION delete_inactive_players(p_offline_threshold_seconds INT DEFAULT 60)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    deleted_count INT;
    threshold TIMESTAMPTZ;
BEGIN
    threshold := NOW() - (p_offline_threshold_seconds || ' seconds')::INTERVAL;

    -- Delete players with last_heartbeat older than threshold
    DELETE FROM players
    WHERE last_heartbeat < threshold OR last_heartbeat IS NULL;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    -- Log the bulk deletion
    INSERT INTO event_log (event_type, payload)
    VALUES (
        'inactive_players_deleted',
        jsonb_build_object(
            'deleted_count', deleted_count,
            'threshold_seconds', p_offline_threshold_seconds,
            'timestamp', NOW()
        )
    );

    RETURN json_build_object(
        'status', 'success',
        'deleted_count', deleted_count,
        'threshold_seconds', p_offline_threshold_seconds
    );
END;
$$;

-- Add comments for documentation
COMMENT ON FUNCTION reorder_players IS 'Reorders player instances by updating their priority values. Takes arrays of player_ids and their new priorities.';
COMMENT ON FUNCTION delete_player_instance IS 'Deletes a player instance and all related records via CASCADE. Logs the deletion to event_log.';
COMMENT ON FUNCTION identify_player IS 'Triggers an identify overlay on the specified player by logging to event_log. The player''s realtime subscription picks this up and displays the name overlay.';
COMMENT ON FUNCTION delete_inactive_players IS 'Deletes all player instances that have been offline for longer than the threshold (default 60 seconds).';
