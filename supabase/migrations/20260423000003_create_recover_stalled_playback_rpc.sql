-- Migration: Create recover_stalled_playback RPC
-- This function recovers playback when no active player is reporting but DB shows playing state
-- It's called periodically to handle cases where all players disconnect or crash

CREATE OR REPLACE FUNCTION recover_stalled_playback(p_player_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    stalled_item RECORD;
    v_current_state TEXT;
    v_last_seen TIMESTAMPTZ;
BEGIN
    -- Get current player state
    SELECT state, last_updated INTO v_current_state, v_last_seen
    FROM player_status
    WHERE player_id = p_player_id;
    
    -- If no player status, nothing to recover
    IF v_current_state IS NULL THEN
        RETURN json_build_object(
            'status', 'no_player_status',
            'reason', 'player_status_not_found'
        );
    END IF;
    
    -- Check if player is actually stalled (state is playing but no recent heartbeat)
    -- Stale threshold: 2 minutes without heartbeat
    IF v_current_state != 'playing' OR (v_last_seen > NOW() - INTERVAL '2 minutes') THEN
        RETURN json_build_object(
            'status', 'not_stalled',
            'reason', 'player_is_active_or_not_playing',
            'current_state', v_current_state,
            'last_seen', v_last_seen
        );
    END IF;
    
    -- Find the stalled playing item
    SELECT * INTO stalled_item
    FROM queue
    WHERE player_id = p_player_id
      AND status = 'playing'
    FOR UPDATE;
    
    -- If no playing item, nothing to recover
    IF stalled_item.id IS NULL THEN
        RETURN json_build_object(
            'status', 'no_playing_item',
            'reason', 'queue_has_no_playing_item'
        );
    END IF;
    
    -- Mark the stalled item as completed and advance to next
    -- This reuses the complete_and_advance logic
    PERFORM complete_and_advance(stalled_item.id);
    
    -- Log the recovery
    INSERT INTO event_log (event_type, queue_id, player_id, payload)
    VALUES (
        'stalled_playback_recovered',
        stalled_item.id,
        p_player_id,
        jsonb_build_object(
            'media_item_id', stalled_item.media_item_id,
            'playback_position', stalled_item.playback_position,
            'recovered_at', NOW()
        )
    );
    
    RETURN json_build_object(
        'status', 'success',
        'recovered_queue_id', stalled_item.id,
        'recovered_media_item_id', stalled_item.media_item_id,
        'playback_position', stalled_item.playback_position
    );
END;
$$;

-- Add comment for documentation
COMMENT ON FUNCTION recover_stalled_playback IS 'Recovers stalled playback when no active player is reporting. Called periodically to handle player disconnections or crashes.';
