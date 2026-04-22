-- Add last_seen column to players table for heartbeat tracking
ALTER TABLE players ADD COLUMN IF NOT EXISTS last_seen timestamptz;

-- Create index on last_seen for efficient heartbeat queries
CREATE INDEX IF NOT EXISTS idx_players_last_seen ON players(last_seen);
