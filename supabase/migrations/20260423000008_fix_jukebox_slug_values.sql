-- Migration: Fix jukebox_slug values for existing players
-- This ensures that players have correct jukebox_slug values for resolution

-- Check and update jukebox_slug for players that might have null or incorrect values
UPDATE players 
SET jukebox_slug = UPPER(REGEXP_REPLACE(name, '[^a-zA-Z0-9]', '_', 'g'))
WHERE jukebox_slug IS NULL OR jukebox_slug = '';

-- Add comment for documentation
COMMENT ON COLUMN players.jukebox_slug IS 'The slug used to identify the jukebox. Used for player resolution via resolve_jukebox_slug function.';
