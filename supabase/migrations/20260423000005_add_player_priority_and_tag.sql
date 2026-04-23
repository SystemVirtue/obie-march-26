-- Migration: Add priority and player_name_tag columns to players table
-- This enables the admin to manage multiple player instances with custom names and priority ordering

-- Add priority column (integer, 1-based ordering)
ALTER TABLE players ADD COLUMN IF NOT EXISTS priority INT DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_players_priority ON players(priority);

-- Add player_name_tag column for custom display names
ALTER TABLE players ADD COLUMN IF NOT EXISTS player_name_tag TEXT;

-- Initialize priority for existing players (assign based on creation order)
DO $$
DECLARE
    player_record RECORD;
    priority_counter INT := 1;
BEGIN
    FOR player_record IN SELECT id FROM players ORDER BY created_at ASC LOOP
        UPDATE players
        SET priority = priority_counter
        WHERE id = player_record.id;
        priority_counter := priority_counter + 1;
    END LOOP;
END $$;

-- Add comments for documentation
COMMENT ON COLUMN players.priority IS 'Priority order for player instances (1 = highest priority). Used for display ordering in admin console.';
COMMENT ON COLUMN players.player_name_tag IS 'Custom display name for the player (e.g., "Main Bar", "Remote #1"). If null, defaults to "Player_{priority}".';
