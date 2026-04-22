-- Migration: Create atomic RPC function complete_and_advance
-- This function atomically completes the current playing item and advances to the next queued item.
-- It uses row-level locking and status checks to ensure idempotency and prevent race conditions.
-- Multiple players can call this simultaneously - only one will succeed per item.

CREATE OR REPLACE FUNCTION complete_and_advance(p_queue_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    current_item RECORD;
    next_item RECORD;
    v_player_id UUID;
    v_loop BOOLEAN;
    v_active_playlist_id UUID;
    v_loaded_count INT;
BEGIN
    -- Lock the current queue item row to prevent race conditions
    SELECT * INTO current_item
    FROM queue
    WHERE id = p_queue_id
    FOR UPDATE;

    -- If item doesn't exist, return error
    IF current_item.id IS NULL THEN
        RETURN json_build_object(
            'status', 'error',
            'reason', 'queue_item_not_found'
        );
    END IF;

    -- Store player_id for later use
    v_player_id := current_item.player_id;

    -- Only proceed if this item is STILL playing
    -- This is the idempotency guard - if another call already completed this item, we ignore it
    IF current_item.status != 'playing' THEN
        -- Log the duplicate attempt for debugging
        INSERT INTO event_log (event_type, queue_id, player_id, payload)
        VALUES (
            'queue_completion_ignored',
            p_queue_id,
            v_player_id,
            jsonb_build_object(
                'reason', 'already_processed',
                'current_status', current_item.status
            )
        );

        RETURN json_build_object(
            'status', 'ignored',
            'reason', 'already_processed',
            'current_status', current_item.status
        );
    END IF;

    -- Mark current item as completed
    UPDATE queue
    SET
        status = 'completed',
        completed_at = NOW(),
        version = version + 1
    WHERE id = p_queue_id;

    -- Log the completion
    INSERT INTO event_log (event_type, queue_id, player_id, payload)
    VALUES (
        'queue_item_completed',
        p_queue_id,
        v_player_id,
        jsonb_build_object(
            'media_item_id', current_item.media_item_id,
            'version', current_item.version + 1
        )
    );

    -- Select next queued item (priority first, then normal)
    -- Use advisory lock to prevent race conditions on queue selection
    PERFORM pg_advisory_xact_lock(hashtext('queue_' || v_player_id::text));

    IF EXISTS (
        SELECT 1 FROM queue
        WHERE player_id = v_player_id
          AND type = 'priority'
          AND status = 'queued'
    ) THEN
        SELECT * INTO next_item
        FROM queue
        WHERE player_id = v_player_id
          AND type = 'priority'
          AND status = 'queued'
        ORDER BY position ASC
        LIMIT 1
        FOR UPDATE;
    ELSE
        SELECT * INTO next_item
        FROM queue
        WHERE player_id = v_player_id
          AND type = 'normal'
          AND status = 'queued'
        ORDER BY position ASC
        LIMIT 1
        FOR UPDATE;
    END IF;

    -- If no queued items, check if loop is enabled and reload playlist
    IF next_item.id IS NULL THEN
        SELECT loop INTO v_loop
        FROM player_settings
        WHERE player_id = v_player_id;

        IF v_loop THEN
            SELECT active_playlist_id INTO v_active_playlist_id
            FROM players
            WHERE id = v_player_id;

            IF v_active_playlist_id IS NOT NULL THEN
                -- Reload playlist without shuffle (loop refill doesn't reshuffle)
                SELECT loaded_count INTO v_loaded_count
                FROM load_playlist(v_player_id, v_active_playlist_id, 0, TRUE);

                IF v_loaded_count > 0 THEN
                    -- Try to select the first item from the refilled queue
                    SELECT * INTO next_item
                    FROM queue
                    WHERE player_id = v_player_id
                      AND type = 'normal'
                      AND status = 'queued'
                    ORDER BY position ASC
                    LIMIT 1
                    FOR UPDATE;
                END IF;
            END IF;
        END IF;
    END IF;

    -- If we found a next item, mark it as playing
    IF next_item.id IS NOT NULL THEN
        UPDATE queue
        SET
            status = 'playing',
            started_at = NOW(),
            version = version + 1
        WHERE id = next_item.id;

        -- Update player_status with the new media
        UPDATE player_status
        SET
            current_media_id = next_item.media_item_id,
            state = 'loading',
            progress = 0,
            last_updated = NOW()
        WHERE player_id = v_player_id;

        -- Log the state transition
        INSERT INTO event_log (event_type, queue_id, player_id, payload)
        VALUES (
            'queue_item_started',
            next_item.id,
            v_player_id,
            jsonb_build_object(
                'media_item_id', next_item.media_item_id,
                'type', next_item.type
            )
        );

        RETURN json_build_object(
            'status', 'success',
            'completed_id', p_queue_id,
            'next_id', next_item.id,
            'next_media_item_id', next_item.media_item_id,
            'action', 'advanced'
        );
    ELSE
        -- Queue is exhausted
        -- Update player_status to idle
        UPDATE player_status
        SET
            current_media_id = NULL,
            state = 'idle',
            progress = 0,
            last_updated = NOW()
        WHERE player_id = v_player_id;

        -- Log queue exhausted
        INSERT INTO event_log (event_type, queue_id, player_id, payload)
        VALUES (
            'queue_exhausted',
            p_queue_id,
            v_player_id,
            jsonb_build_object('reason', 'no_more_items')
        );

        RETURN json_build_object(
            'status', 'success',
            'completed_id', p_queue_id,
            'next_id', NULL,
            'action', 'exhausted'
        );
    END IF;
END;
$$;

-- Add comment for documentation
COMMENT ON FUNCTION complete_and_advance IS 'Atomically completes the current playing queue item and advances to the next. Idempotent - duplicate calls are safely ignored.';
