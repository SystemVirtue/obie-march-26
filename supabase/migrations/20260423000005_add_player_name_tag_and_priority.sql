-- Migration: Add player_name_tag, priority, and identify_tag columns to players table
-- This enables the new Player Instances view in the admin console
-- Add player_name_tag column for custom player names
ALTER TABLE players
ADD COLUMN player_name_tag TEXT;
-- Add priority column for player ordering
ALTER TABLE players
ADD COLUMN priority INT DEFAULT 1;
-- Add identify_tag column for player identify overlay
ALTER TABLE players
ADD COLUMN identify_tag TEXT;
-- Add comment for documentation
COMMENT ON COLUMN players.player_name_tag IS 'Custom name tag for player display (e.g., "Main Bar", "Remote #1"). Defaults to "Player_{priority}" if null.';
COMMENT ON COLUMN players.priority IS 'Priority order for player display (1 = highest priority). Used for drag-and-drop reordering.';
COMMENT ON COLUMN players.identify_tag IS 'Temporary tag to display on player screen for identification. Set by admin Identify button, cleared by player after display.';
-- Initialize priority values based on creation order (older players get higher priority)
UPDATE players
SET priority = (
    SELECT COUNT(*) + 1
    FROM players p2
    WHERE p2.created_at <= players.created_at
  );
-- Create index on priority for efficient ordering
CREATE INDEX idx_players_priority ON players(priority);
-- Initialize player_name_tag with default values if null
UPDATE players
SET player_name_tag = 'Player_' || priority::text
WHERE player_name_tag IS NULL;