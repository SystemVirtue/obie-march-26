-- Add player_mode to player_settings
-- Allows switching between YouTube iframe embed and YTM Desktop Companion API
ALTER TABLE player_settings
  ADD COLUMN IF NOT EXISTS player_mode TEXT DEFAULT 'iframe'
    CHECK (player_mode IN ('iframe', 'ytm_desktop'));
