-- Migration: Add unique index to ensure only one playing item per player
-- This enforces the invariant that at most one queue item can be in 'playing' state
-- for each player at any given time.

CREATE UNIQUE INDEX IF NOT EXISTS one_playing_item_per_player
ON queue (player_id)
WHERE status = 'playing';

-- Add comment for documentation
COMMENT ON INDEX one_playing_item_per_player IS 'Ensures at most one queue item is in "playing" state per player';
