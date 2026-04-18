-- Obie Jukebox v2 - Complete Schema
-- Server-first architecture with Realtime sync and RLS

-- Enable UUID generation (gen_random_uuid is built into PostgreSQL 13+)

-- =============================================================================
-- TABLES
-- =============================================================================

-- Core player instance
CREATE TABLE players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT DEFAULT 'offline' CHECK (status IN ('offline', 'online', 'error')),
  last_heartbeat TIMESTAMPTZ DEFAULT NOW(),
  active_playlist_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Playlist library
CREATE TABLE playlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Normalized playlist items (replaces JSONB[] approach)
CREATE TABLE playlist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  playlist_id UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position INT NOT NULL,
  media_item_id UUID NOT NULL,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(playlist_id, position)
);

-- Deduplicated media metadata cache
CREATE TABLE media_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id TEXT UNIQUE NOT NULL, -- e.g., "youtube:dQw4w9WgXcQ"
  source_type TEXT NOT NULL DEFAULT 'youtube',
  title TEXT NOT NULL,
  artist TEXT,
  url TEXT NOT NULL,
  duration INT, -- seconds
  thumbnail TEXT,
  fetched_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Unified queue (normal + priority)
CREATE TABLE queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'normal' CHECK (type IN ('normal', 'priority')),
  media_item_id UUID NOT NULL REFERENCES media_items(id),
  position INT NOT NULL,
  requested_by TEXT, -- session_id or 'admin' or 'playlist'
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  played_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 minutes',
  UNIQUE(player_id, type, position)
);

-- Live player state
CREATE TABLE player_status (
  player_id UUID PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'playing', 'paused', 'error', 'loading')),
  progress FLOAT DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  current_media_id UUID REFERENCES media_items(id),
  now_playing_index INT DEFAULT 0,
  queue_head_position INT DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT NOW()
);

-- Player settings
CREATE TABLE player_settings (
  player_id UUID PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  loop BOOLEAN DEFAULT false,
  shuffle BOOLEAN DEFAULT false,
  volume INT DEFAULT 75 CHECK (volume >= 0 AND volume <= 100),
  freeplay BOOLEAN DEFAULT false,
  coin_per_song INT DEFAULT 1 CHECK (coin_per_song > 0),
  branding JSONB DEFAULT '{
    "name": "Obie Jukebox",
    "logo": "",
    "theme": "dark"
  }'::jsonb,
  search_enabled BOOLEAN DEFAULT true,
  max_queue_size INT DEFAULT 50,
  priority_queue_limit INT DEFAULT 10
);

-- Kiosk session + credits
CREATE TABLE kiosk_sessions (
  session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  credits INT DEFAULT 0 CHECK (credits >= 0),
  last_active TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  ip_address INET,
  user_agent TEXT
);

-- System logs with severity
CREATE TABLE system_logs (
  id BIGSERIAL PRIMARY KEY,
  player_id UUID REFERENCES players(id) ON DELETE SET NULL,
  event TEXT NOT NULL,
  severity TEXT DEFAULT 'info' CHECK (severity IN ('debug', 'info', 'warn', 'error')),
  payload JSONB DEFAULT '{}'::jsonb,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_queue_player_type_position ON queue(player_id, type, position) WHERE played_at IS NULL;
CREATE INDEX idx_queue_expires ON queue(expires_at) WHERE played_at IS NULL;
CREATE INDEX idx_playlist_items_playlist ON playlist_items(playlist_id, position);
CREATE INDEX idx_media_items_source ON media_items(source_id);
CREATE INDEX idx_system_logs_player_severity ON system_logs(player_id, severity, timestamp DESC);
CREATE INDEX idx_kiosk_sessions_player ON kiosk_sessions(player_id, last_active DESC);

-- =============================================================================
-- SQL RPC FUNCTIONS
-- =============================================================================

-- Helper: Log events atomically
CREATE OR REPLACE FUNCTION log_event(
  p_player_id UUID,
  p_event TEXT,
  p_severity TEXT DEFAULT 'info',
  p_payload JSONB DEFAULT '{}'
)
RETURNS void AS $$
BEGIN
  INSERT INTO system_logs (player_id, event, severity, payload)
  VALUES (p_player_id, p_event, p_severity, p_payload);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 1. Add item to queue
CREATE OR REPLACE FUNCTION queue_add(
  p_player_id UUID,
  p_media_item_id UUID,
  p_type TEXT DEFAULT 'normal',
  p_requested_by TEXT DEFAULT 'admin'
)
RETURNS UUID AS $$
DECLARE
  v_queue_id UUID;
  v_next_position INT;
  v_max_size INT;
  v_current_count INT;
BEGIN
  -- Acquire advisory lock for this player's queue
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));
  
  -- Check queue limits
  SELECT max_queue_size INTO v_max_size 
  FROM player_settings 
  WHERE player_id = p_player_id;
  
  SELECT COUNT(*) INTO v_current_count 
  FROM queue 
  WHERE player_id = p_player_id AND played_at IS NULL;
  
  IF v_current_count >= v_max_size THEN
    RAISE EXCEPTION 'Queue is full (max: %)', v_max_size;
  END IF;
  
  -- Get next position
  SELECT COALESCE(MAX(position) + 1, 0) INTO v_next_position
  FROM queue
  WHERE player_id = p_player_id AND type = p_type AND played_at IS NULL;
  
  -- Insert queue item
  INSERT INTO queue (player_id, media_item_id, type, position, requested_by)
  VALUES (p_player_id, p_media_item_id, p_type, v_next_position, p_requested_by)
  RETURNING id INTO v_queue_id;
  
  -- Log event
  PERFORM log_event(p_player_id, 'queue_add', 'info', jsonb_build_object(
    'queue_id', v_queue_id,
    'type', p_type,
    'position', v_next_position
  ));
  
  RETURN v_queue_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Remove item from queue
CREATE OR REPLACE FUNCTION queue_remove(
  p_queue_id UUID
)
RETURNS void AS $$
DECLARE
  v_player_id UUID;
  v_type TEXT;
  v_position INT;
BEGIN
  -- Get queue item details
  SELECT player_id, type, position INTO v_player_id, v_type, v_position
  FROM queue
  WHERE id = p_queue_id AND played_at IS NULL;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Queue item not found or already played';
  END IF;
  
  -- Acquire lock
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || v_player_id::text));
  
  -- Delete item
  DELETE FROM queue WHERE id = p_queue_id;
  
  -- Reorder remaining items
  UPDATE queue
  SET position = position - 1
  WHERE player_id = v_player_id 
    AND type = v_type 
    AND position > v_position 
    AND played_at IS NULL;
  
  -- Log event
  PERFORM log_event(v_player_id, 'queue_remove', 'info', jsonb_build_object('queue_id', p_queue_id));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Reorder queue items
CREATE OR REPLACE FUNCTION queue_reorder(
  p_player_id UUID,
  p_queue_ids UUID[],
  p_type TEXT DEFAULT 'normal'
)
RETURNS void AS $$
DECLARE
  i INT;
BEGIN
  -- Acquire lock
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));
  
  -- Update positions based on array order
  FOR i IN 1..array_length(p_queue_ids, 1) LOOP
    UPDATE queue
    SET position = i - 1
    WHERE id = p_queue_ids[i] AND player_id = p_player_id AND type = p_type;
  END LOOP;
  
  -- Log event
  PERFORM log_event(p_player_id, 'queue_reorder', 'info', jsonb_build_object('count', array_length(p_queue_ids, 1)));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Get next item to play (respects priority queue)
CREATE OR REPLACE FUNCTION queue_next(
  p_player_id UUID
)
RETURNS TABLE(media_item_id UUID, title TEXT, url TEXT, duration INT) AS $$
DECLARE
  v_next_queue_item RECORD;
  v_shuffle BOOLEAN;
BEGIN
  -- Acquire lock
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));
  
  -- Check shuffle setting
  SELECT shuffle INTO v_shuffle FROM player_settings WHERE player_id = p_player_id;
  
  -- Get next item (priority first, then normal)
  IF v_shuffle AND EXISTS (SELECT 1 FROM queue WHERE player_id = p_player_id AND type = 'normal' AND played_at IS NULL) THEN
    -- Random from normal queue if shuffle enabled
    SELECT q.id, q.media_item_id, q.type INTO v_next_queue_item
    FROM queue q
    WHERE q.player_id = p_player_id 
      AND q.type = 'normal'
      AND q.played_at IS NULL
    ORDER BY RANDOM()
    LIMIT 1;
  ELSE
    -- Priority first, then sequential
    SELECT q.id, q.media_item_id, q.type INTO v_next_queue_item
    FROM queue q
    WHERE q.player_id = p_player_id 
      AND q.played_at IS NULL
    ORDER BY 
      CASE WHEN q.type = 'priority' THEN 0 ELSE 1 END,
      q.position ASC
    LIMIT 1;
  END IF;
  
  IF v_next_queue_item IS NULL THEN
    -- No items in queue - check active playlist
    RETURN QUERY
    SELECT NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::INT
    WHERE FALSE;
    RETURN;
  END IF;
  
  -- Mark as played
  UPDATE queue
  SET played_at = NOW()
  WHERE id = v_next_queue_item.id;
  
  -- Update player status
  UPDATE player_status
  SET 
    current_media_id = v_next_queue_item.media_item_id,
    state = 'loading',
    progress = 0,
    last_updated = NOW()
  WHERE player_id = p_player_id;
  
  -- Log event
  PERFORM log_event(p_player_id, 'queue_next', 'info', jsonb_build_object(
    'media_item_id', v_next_queue_item.media_item_id,
    'type', v_next_queue_item.type
  ));
  
  -- Return media details
  RETURN QUERY
  SELECT m.id, m.title, m.url, m.duration
  FROM media_items m
  WHERE m.id = v_next_queue_item.media_item_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Skip current song
CREATE OR REPLACE FUNCTION queue_skip(
  p_player_id UUID
)
RETURNS void AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));
  
  -- Update player status to trigger next
  UPDATE player_status
  SET state = 'idle', progress = 0
  WHERE player_id = p_player_id;
  
  -- Log event
  PERFORM log_event(p_player_id, 'queue_skip', 'info', '{}');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. Clear queue
CREATE OR REPLACE FUNCTION queue_clear(
  p_player_id UUID,
  p_type TEXT DEFAULT NULL -- NULL = clear all, 'normal' or 'priority' = clear specific
)
RETURNS void AS $$
DECLARE
  v_count INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));
  
  -- Delete items
  IF p_type IS NULL THEN
    DELETE FROM queue WHERE player_id = p_player_id AND played_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSE
    DELETE FROM queue WHERE player_id = p_player_id AND type = p_type AND played_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;
  
  -- Log event
  PERFORM log_event(p_player_id, 'queue_clear', 'info', jsonb_build_object('count', v_count, 'type', p_type));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Helper: Increment kiosk credits
CREATE OR REPLACE FUNCTION kiosk_increment_credit(
  p_session_id UUID,
  p_amount INT DEFAULT 1
)
RETURNS INT AS $$
DECLARE
  v_new_credits INT;
BEGIN
  UPDATE kiosk_sessions
  SET 
    credits = credits + p_amount,
    last_active = NOW()
  WHERE session_id = p_session_id
  RETURNING credits INTO v_new_credits;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found';
  END IF;
  
  RETURN v_new_credits;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Helper: Decrement kiosk credits
CREATE OR REPLACE FUNCTION kiosk_decrement_credit(
  p_session_id UUID,
  p_amount INT DEFAULT 1
)
RETURNS INT AS $$
DECLARE
  v_new_credits INT;
  v_player_id UUID;
BEGIN
  UPDATE kiosk_sessions
  SET 
    credits = GREATEST(0, credits - p_amount),
    last_active = NOW()
  WHERE session_id = p_session_id
  RETURNING credits, player_id INTO v_new_credits, v_player_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found';
  END IF;
  
  -- Log credit usage
  PERFORM log_event(v_player_id, 'kiosk_credit_used', 'info', jsonb_build_object(
    'session_id', p_session_id,
    'amount', p_amount,
    'remaining', v_new_credits
  ));
  
  RETURN v_new_credits;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Helper: Update player heartbeat
CREATE OR REPLACE FUNCTION player_heartbeat(
  p_player_id UUID
)
RETURNS void AS $$
BEGIN
  UPDATE players
  SET 
    status = 'online',
    last_heartbeat = NOW(),
    updated_at = NOW()
  WHERE id = p_player_id;
  
  -- Mark offline if no heartbeat in 10 seconds
  UPDATE players
  SET status = 'offline'
  WHERE id != p_player_id 
    AND status = 'online' 
    AND last_heartbeat < NOW() - INTERVAL '10 seconds';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================================================

-- Enable RLS on all tables
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE playlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE playlist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE kiosk_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_logs ENABLE ROW LEVEL SECURITY;

-- Admin has full access (authenticated users)
CREATE POLICY "Admin full access to players"
  ON players FOR ALL
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admin full access to playlists"
  ON playlists FOR ALL
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admin full access to playlist_items"
  ON playlist_items FOR ALL
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admin full access to media_items"
  ON media_items FOR ALL
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admin full access to queue"
  ON queue FOR ALL
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admin full access to player_status"
  ON player_status FOR ALL
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admin full access to player_settings"
  ON player_settings FOR ALL
  USING (auth.role() = 'authenticated');

CREATE POLICY "Admin full access to system_logs"
  ON system_logs FOR SELECT
  USING (auth.role() = 'authenticated');

-- Kiosk can read limited data (anon access)
CREATE POLICY "Kiosk can read own session"
  ON kiosk_sessions FOR SELECT
  USING (true);

CREATE POLICY "Kiosk can update own session"
  ON kiosk_sessions FOR UPDATE
  USING (true);

CREATE POLICY "Kiosk can read media items"
  ON media_items FOR SELECT
  USING (true);

CREATE POLICY "Kiosk can read player settings"
  ON player_settings FOR SELECT
  USING (true);

-- Player can read/update its own status
CREATE POLICY "Player can read own status"
  ON player_status FOR SELECT
  USING (true);

CREATE POLICY "Player can update own status"
  ON player_status FOR UPDATE
  USING (true);

-- =============================================================================
-- TRIGGERS
-- =============================================================================

-- Auto-update updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER players_updated_at
  BEFORE UPDATE ON players
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER playlists_updated_at
  BEFORE UPDATE ON playlists
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Cleanup expired queue items (run via pg_cron or manual)
CREATE OR REPLACE FUNCTION cleanup_expired_queue()
RETURNS void AS $$
BEGIN
  DELETE FROM queue 
  WHERE expires_at < NOW() 
    AND played_at IS NULL
    AND type = 'priority'; -- only expire priority requests
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- REALTIME PUBLICATION
-- =============================================================================

-- Enable realtime for all tables
ALTER PUBLICATION supabase_realtime ADD TABLE players;
ALTER PUBLICATION supabase_realtime ADD TABLE playlists;
ALTER PUBLICATION supabase_realtime ADD TABLE playlist_items;
ALTER PUBLICATION supabase_realtime ADD TABLE media_items;
ALTER PUBLICATION supabase_realtime ADD TABLE queue;
ALTER PUBLICATION supabase_realtime ADD TABLE player_status;
ALTER PUBLICATION supabase_realtime ADD TABLE player_settings;
ALTER PUBLICATION supabase_realtime ADD TABLE kiosk_sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE system_logs;

-- =============================================================================
-- SEED DATA
-- =============================================================================

-- Create default player
INSERT INTO players (id, name, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default Player', 'offline');

-- Create default player status
INSERT INTO player_status (player_id, state)
VALUES ('00000000-0000-0000-0000-000000000001', 'idle');

-- Create default player settings
INSERT INTO player_settings (player_id)
VALUES ('00000000-0000-0000-0000-000000000001');

-- Create default playlist
INSERT INTO playlists (id, player_id, name, is_active)
VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Main Playlist', true);

-- Sample media items
INSERT INTO media_items (id, source_id, title, artist, url, duration, thumbnail)
VALUES 
  ('10000000-0000-0000-0000-000000000001', 'youtube:dQw4w9WgXcQ', 'Never Gonna Give You Up', 'Rick Astley', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 213, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg'),
  ('10000000-0000-0000-0000-000000000002', 'youtube:9bZkp7q19f0', 'Gangnam Style', 'PSY', 'https://www.youtube.com/watch?v=9bZkp7q19f0', 252, 'https://i.ytimg.com/vi/9bZkp7q19f0/default.jpg');

-- Add to playlist
INSERT INTO playlist_items (playlist_id, position, media_item_id)
VALUES 
  ('00000000-0000-0000-0000-000000000002', 0, '10000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002', 1, '10000000-0000-0000-0000-000000000002');
