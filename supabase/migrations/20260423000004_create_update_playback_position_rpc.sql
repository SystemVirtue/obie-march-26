-- Migration: Create update_playback_position RPC
-- This function updates the playback position for a queue item
-- Called periodically by the active player to enable resume functionality

CREATE OR REPLACE FUNCTION update_playback_position(p_queue_id UUID, p_position FLOAT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    queue_item RECORD;
BEGIN
    -- Lock the queue item row
    SELECT * INTO queue_item
    FROM queue
    WHERE id = p_queue_id
    FOR UPDATE;

    -- If item doesn't exist, return error
    IF queue_item.id IS NULL THEN
        RETURN json_build_object(
            'status', 'error',
            'reason', 'queue_item_not_found'
        );
    END IF;

    -- Update playback position
    UPDATE queue
    SET playback_position = p_position
    WHERE id = p_queue_id;

    RETURN json_build_object(
        'status', 'success',
        'queue_id', p_queue_id,
        'position', p_position
    );
END;
$$;

-- Add comment for documentation
COMMENT ON FUNCTION update_playback_position IS 'Updates playback position for a queue item. Called periodically by active player for resume capability.';
