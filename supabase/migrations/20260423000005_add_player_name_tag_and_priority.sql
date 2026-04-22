-- Migration: Add player_name_tag, priority, and identify_tag columns to players table
-- This enables the new Player Instances view in the admin console
-- Add player_name_tag column for custom player names (if not exists)
DO $$ BEGIN IF NOT EXISTS (
  SELECT 1
  FROM information_schema.columns
  WHERE table_name = 'players'
    AND column_name = 'player_name_tag'
) THEN
ALTER TABLE players
ADD COLUMN player_name_tag TEXT;
END IF;
END $$;
-- Add priority column for player ordering (if not exists)
DO $$ BEGIN IF NOT EXISTS (
  SELECT 1
  FROM information_schema.columns
  WHERE table_name = 'players'
    AND column_name = 'priority'
) THEN
ALTER TABLE players
ADD COLUMN priority INT DEFAULT 1;
END IF;
END $$;
-- Add identify_tag column for player identify overlay (if not exists)
DO $$ BEGIN IF NOT EXISTS (
  SELECT 1
  FROM information_schema.columns
  WHERE table_name = 'players'
    AND column_name = 'identify_tag'
) THEN
ALTER TABLE players
ADD COLUMN identify_tag TEXT;
END IF;
END $$;
-- Add comment for documentation
COMMENT ON COLUMN players.player_name_tag IS 'Custom name tag for player display (e.g., "Main Bar", "Remote #1"). Defaults to "Player_{priority}" if null.';
COMMENT ON COLUMN players.priority IS 'Priority order for player display (1 = highest priority). Used for drag-and-drop reordering.';
COMMENT ON COLUMN players.identify_tag IS 'Temporary tag to display on player screen for identification. Set by admin Identify button, cleared by player after display.';
-- Initialize priority values based on creation order (only for null values)
UPDATE players
SET priority = (
    SELECT COUNT(*) + 1
    FROM players p2
    WHERE p2.created_at <= players.created_at
  )
WHERE priority IS NULL;
-- Create index on priority for efficient ordering (if not exists)
CREATE INDEX IF NOT EXISTS idx_players_priority ON players(priority);
-- Initialize player_name_tag with default values if null
UPDATE players
SET player_name_tag = 'Player_' || priority::text
WHERE player_name_tag IS NULL;