-- Migration: Add last_refresh column to players table
-- This tracks when a player last initialized or refreshed

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'players' AND column_name = 'last_refresh'
  ) THEN
    ALTER TABLE players ADD COLUMN last_refresh TIMESTAMPTZ;
  END IF;
END $$;

-- Add comment for documentation
COMMENT ON COLUMN players.last_refresh IS 'Timestamp of when the player last initialized or refreshed. Updated by player on each load/refresh.';

-- Initialize last_refresh with current timestamp for existing players
UPDATE players SET last_refresh = NOW() WHERE last_refresh IS NULL;
