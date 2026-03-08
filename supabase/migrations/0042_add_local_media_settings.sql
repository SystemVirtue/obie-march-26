-- Add local media settings to player_settings
ALTER TABLE player_settings
  ADD COLUMN IF NOT EXISTS local_media_enabled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS local_media_path TEXT DEFAULT NULL;

COMMENT ON COLUMN player_settings.local_media_enabled IS 'Whether local media folder is enabled for playback alongside YouTube content';
COMMENT ON COLUMN player_settings.local_media_path IS 'Path or name of the local folder containing video files';
