-- Add Cloudflare R2 settings to player_settings
ALTER TABLE player_settings
  ADD COLUMN IF NOT EXISTS cloudflare_enabled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS cloudflare_r2_public_url TEXT;

-- Extend the CHECK constraint on player_status.source to allow 'cloudflare'
-- Drop old constraint and re-add with the new value
ALTER TABLE player_status DROP CONSTRAINT IF EXISTS player_status_source_check;
ALTER TABLE player_status ADD CONSTRAINT player_status_source_check
  CHECK (source IN ('youtube', 'local', 'cloudflare'));
