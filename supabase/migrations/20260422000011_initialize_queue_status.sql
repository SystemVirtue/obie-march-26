-- Migration: Initialize queue status for server-controlled progression
-- This migration sets the initial status for all queue items based on the current
-- player_status and queue state to ensure compatibility with the new
-- complete_and_advance RPC function.

-- First, set all unplayed items to 'queued'
UPDATE queue
SET status = 'queued'
WHERE status IS NULL AND played_at IS NULL;

-- Set all played items to 'completed'
UPDATE queue
SET 
  status = 'completed',
  completed_at = played_at
WHERE status IS NULL AND played_at IS NOT NULL;

-- For each player, find the currently playing item from player_status
-- and set it to 'playing' status in the queue table
DO $$
DECLARE
  player_record RECORD;
  v_current_media_id UUID;
  queue_item_id UUID;
BEGIN
  FOR player_record IN SELECT player_id, current_media_id FROM player_status WHERE current_media_id IS NOT NULL LOOP
    v_current_media_id := player_record.current_media_id;

    -- Find the queue item for this media item that hasn't been played yet
    SELECT id INTO queue_item_id
    FROM queue
    WHERE player_id = player_record.player_id
      AND media_item_id = v_current_media_id
      AND played_at IS NULL
    LIMIT 1;

    -- If found, set it to playing status
    IF queue_item_id IS NOT NULL THEN
      UPDATE queue
      SET
        status = 'playing',
        started_at = NOW(),
        version = 0
      WHERE id = queue_item_id;
    END IF;
  END LOOP;
END $$;

-- Ensure all remaining items have status set (fallback to queued)
UPDATE queue
SET status = 'queued'
WHERE status IS NULL;
