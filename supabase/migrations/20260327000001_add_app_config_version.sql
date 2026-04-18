-- App config table for version tracking and auto-reload across all frontends.
-- All connected Admin, Player, and Kiosk instances subscribe via Realtime
-- and auto-reload when app_version changes.

CREATE TABLE IF NOT EXISTS app_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed with initial version (current timestamp)
INSERT INTO app_config (key, value, updated_at)
VALUES ('app_version', TO_CHAR(NOW(), 'YYYYMMDDHH24MISS'), NOW())
ON CONFLICT (key) DO NOTHING;

-- Enable Realtime on app_config so frontends get instant push notifications
ALTER PUBLICATION supabase_realtime ADD TABLE app_config;

-- RLS: anyone can read, only service_role can write
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read app_config"
  ON app_config FOR SELECT
  USING (true);

-- Helper function to bump the version (call after deploy)
CREATE OR REPLACE FUNCTION bump_app_version()
RETURNS TEXT AS $$
DECLARE
  new_version TEXT;
BEGIN
  new_version := TO_CHAR(NOW(), 'YYYYMMDDHH24MISS');
  UPDATE app_config
  SET value = new_version, updated_at = NOW()
  WHERE key = 'app_version';
  RETURN new_version;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION bump_app_version() TO service_role;
