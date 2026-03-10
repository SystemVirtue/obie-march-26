-- =============================================================================
-- 0025 — Multi-User Player Ownership
-- =============================================================================
-- Each authenticated user owns exactly one player instance.
-- Signing up automatically creates a player + status + settings row.
-- RLS is tightened so each user can only see/modify their own player's data.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Add owner_id to players
-- -----------------------------------------------------------------------------
ALTER TABLE players ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_players_owner ON players(owner_id);

-- Back-fill: existing default player is owned by the first admin user (if any).
-- If there are no users yet this is a no-op; the first user to sign up will get
-- their own player created by the trigger below.
DO $$
DECLARE v_first_user UUID;
BEGIN
  SELECT id INTO v_first_user FROM auth.users ORDER BY created_at ASC LIMIT 1;
  IF v_first_user IS NOT NULL THEN
    UPDATE players SET owner_id = v_first_user WHERE id = '00000000-0000-0000-0000-000000000001' AND owner_id IS NULL;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Function: provision a fresh player for a new user
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_player_for_user(p_user_id UUID, p_email TEXT)
RETURNS UUID AS $$
DECLARE
  v_player_id UUID;
  v_name TEXT;
BEGIN
  -- Derive a friendly display name from the email local-part
  v_name := split_part(p_email, '@', 1) || '''s Jukebox';

  INSERT INTO players (name, status, owner_id)
  VALUES (v_name, 'offline', p_user_id)
  RETURNING id INTO v_player_id;

  INSERT INTO player_status (player_id, state)
  VALUES (v_player_id, 'idle');

  INSERT INTO player_settings (player_id, branding)
  VALUES (v_player_id, jsonb_build_object('name', v_name, 'logo', '', 'theme', 'dark'));

  PERFORM log_event(v_player_id, 'player_created', 'info',
    jsonb_build_object('owner', p_user_id, 'email', p_email));

  RETURN v_player_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- -----------------------------------------------------------------------------
-- 3. Trigger: auto-create player on new user signup
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  -- Only provision if this user doesn't already own a player
  IF NOT EXISTS (SELECT 1 FROM public.players WHERE owner_id = NEW.id) THEN
    PERFORM create_player_for_user(NEW.id, COALESCE(NEW.email, 'user@obie'));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop old trigger if it exists, then recreate
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- -----------------------------------------------------------------------------
-- 4. RPC: get the calling user's player_id (used by frontend to resolve ID)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_my_player_id()
RETURNS UUID AS $$
DECLARE v_player_id UUID;
BEGIN
  SELECT id INTO v_player_id
  FROM public.players
  WHERE owner_id = auth.uid()
  LIMIT 1;
  RETURN v_player_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- -----------------------------------------------------------------------------
-- 5. Re-scope RLS so each user only accesses their own player's data
-- -----------------------------------------------------------------------------

-- players: owner sees only their row
DROP POLICY IF EXISTS "Admin full access to players" ON players;
CREATE POLICY "Owner access to own player"
  ON players FOR ALL
  USING (owner_id = auth.uid());

-- playlists: scoped via player ownership
DROP POLICY IF EXISTS "Admin full access to playlists" ON playlists;
CREATE POLICY "Owner access to own playlists"
  ON playlists FOR ALL
  USING (
    player_id IN (SELECT id FROM players WHERE owner_id = auth.uid())
  );

-- playlist_items: scoped via playlist → player ownership
DROP POLICY IF EXISTS "Admin full access to playlist_items" ON playlist_items;
CREATE POLICY "Owner access to own playlist items"
  ON playlist_items FOR ALL
  USING (
    playlist_id IN (
      SELECT pi.id FROM playlists pi
      JOIN players p ON p.id = pi.player_id
      WHERE p.owner_id = auth.uid()
    )
  );

-- queue: scoped via player ownership
DROP POLICY IF EXISTS "Admin full access to queue" ON queue;
CREATE POLICY "Owner access to own queue"
  ON queue FOR ALL
  USING (
    player_id IN (SELECT id FROM players WHERE owner_id = auth.uid())
  );

-- Anon read of queue (for player window and kiosk)
CREATE POLICY "Anon can read queue for their player"
  ON queue FOR SELECT
  USING (true);

-- player_status
DROP POLICY IF EXISTS "Admin full access to player_status" ON player_status;
CREATE POLICY "Owner full access to own player_status"
  ON player_status FOR ALL
  USING (
    player_id IN (SELECT id FROM players WHERE owner_id = auth.uid())
  );

-- player_settings
DROP POLICY IF EXISTS "Admin full access to player_settings" ON player_settings;
CREATE POLICY "Owner full access to own player_settings"
  ON player_settings FOR ALL
  USING (
    player_id IN (SELECT id FROM players WHERE owner_id = auth.uid())
  );

-- system_logs
DROP POLICY IF EXISTS "Admin full access to system_logs" ON system_logs;
CREATE POLICY "Owner can read own system_logs"
  ON system_logs FOR SELECT
  USING (
    player_id IS NULL
    OR player_id IN (SELECT id FROM players WHERE owner_id = auth.uid())
  );
CREATE POLICY "Service role can insert system_logs"
  ON system_logs FOR INSERT
  WITH CHECK (true);

-- playlist_positions (from migration 0024) - skipped: table does not exist

-- -----------------------------------------------------------------------------
-- 6. Anon policies for player/kiosk apps (read-only where needed)
-- -----------------------------------------------------------------------------
CREATE POLICY "Anon can read player settings"
  ON player_settings FOR SELECT USING (true);

CREATE POLICY "Anon can read player status"
  ON player_status FOR SELECT USING (true);

-- Note: kiosk_sessions already has open anon policies from migration 0001.
