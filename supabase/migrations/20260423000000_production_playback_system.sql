-- ============================================================
-- OBI Jukebox: Deterministic Playback + Self-Healing Queue
-- Full Supabase Migration
-- ============================================================
-- =========================
-- EXTENSIONS
-- =========================
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_cron;
-- =========================
-- QUEUE TABLE UPDATES
-- =========================
ALTER TABLE queue
ADD COLUMN IF NOT EXISTS status TEXT CHECK (
        status IN ('queued', 'playing', 'completed', 'skipped')
    ) DEFAULT 'queued',
    ADD COLUMN IF NOT EXISTS version INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMP,
    ADD COLUMN IF NOT EXISTS expected_end TIMESTAMP,
    ADD COLUMN IF NOT EXISTS playback_state TEXT CHECK (
        playback_state IN ('playing', 'paused', 'ended', 'buffering')
    ),
    ADD COLUMN IF NOT EXISTS user_paused BOOLEAN DEFAULT FALSE;
-- =========================
-- INDEXES & CONSTRAINTS
-- =========================
-- Only ONE playing item allowed per player
CREATE UNIQUE INDEX IF NOT EXISTS one_playing_item_per_player ON queue (player_id, (status))
WHERE status = 'playing';
-- Fast lookup indexes
CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
CREATE INDEX IF NOT EXISTS idx_queue_player_status ON queue(player_id, status);
CREATE INDEX IF NOT EXISTS idx_queue_requested_at ON queue(requested_at);
-- =========================
-- EVENT LOG TABLE (if not exists)
-- =========================
CREATE TABLE IF NOT EXISTS event_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT,
    queue_id UUID,
    player_id UUID,
    payload JSONB,
    created_at TIMESTAMP DEFAULT now()
);
-- =========================
-- RPC: START NEXT
-- =========================
CREATE OR REPLACE FUNCTION start_next() RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE next_item RECORD;
v_duration INT;
BEGIN -- Lock next available item
SELECT * INTO next_item
FROM queue
WHERE status = 'queued'
ORDER BY CASE
        WHEN type = 'priority' THEN 0
        ELSE 1
    END,
    position ASC
LIMIT 1 FOR
UPDATE SKIP LOCKED;
IF next_item.id IS NULL THEN RETURN json_build_object('status', 'empty');
END IF;
-- Get duration from media_items
SELECT duration INTO v_duration
FROM media_items
WHERE id = next_item.media_item_id;
UPDATE queue
SET status = 'playing',
    started_at = now(),
    expected_end = now() + interval '1 second' * COALESCE(v_duration, 0),
    playback_state = 'playing',
    user_paused = FALSE,
    version = version + 1,
    last_heartbeat = now()
WHERE id = next_item.id;
INSERT INTO event_log(event_type, queue_id, player_id, payload)
VALUES (
        'start',
        next_item.id,
        next_item.player_id,
        json_build_object()
    );
RETURN json_build_object(
    'status',
    'started',
    'queue_id',
    next_item.id,
    'media_item_id',
    next_item.media_item_id
);
END;
$$;
-- =========================
-- RPC: COMPLETE + ADVANCE (updated)
-- =========================
CREATE OR REPLACE FUNCTION complete_and_advance(p_queue_id UUID) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE current_item RECORD;
next_item RECORD;
v_player_id UUID;
v_loop BOOLEAN;
v_active_playlist_id UUID;
v_loaded_count INT;
v_duration INT;
BEGIN
SELECT * INTO current_item
FROM queue
WHERE id = p_queue_id FOR
UPDATE;
IF current_item.id IS NULL THEN RETURN json_build_object(
    'status',
    'error',
    'reason',
    'queue_item_not_found'
);
END IF;
v_player_id := current_item.player_id;
-- Idempotency guard
IF current_item.status != 'playing' THEN
INSERT INTO event_log(event_type, queue_id, player_id, payload)
VALUES (
        'ignored_duplicate',
        p_queue_id,
        v_player_id,
        json_build_object(
            'reason',
            'already_processed',
            'current_status',
            current_item.status
        )
    );
RETURN json_build_object(
    'status',
    'ignored',
    'reason',
    'already_processed'
);
END IF;
UPDATE queue
SET status = 'completed',
    completed_at = now(),
    playback_state = 'ended',
    version = version + 1
WHERE id = p_queue_id;
INSERT INTO event_log(event_type, queue_id, player_id, payload)
VALUES (
        'completed',
        p_queue_id,
        v_player_id,
        json_build_object()
    );
-- Select next queued item
PERFORM pg_advisory_xact_lock(hashtext('queue_' || v_player_id::text));
IF EXISTS (
    SELECT 1
    FROM queue
    WHERE player_id = v_player_id
        AND type = 'priority'
        AND status = 'queued'
) THEN
SELECT * INTO next_item
FROM queue
WHERE player_id = v_player_id
    AND type = 'priority'
    AND status = 'queued'
ORDER BY position ASC
LIMIT 1 FOR
UPDATE;
ELSE
SELECT * INTO next_item
FROM queue
WHERE player_id = v_player_id
    AND type = 'normal'
    AND status = 'queued'
ORDER BY position ASC
LIMIT 1 FOR
UPDATE;
END IF;
-- If no queued items, check loop and reload
IF next_item.id IS NULL THEN
SELECT loop INTO v_loop
FROM player_settings
WHERE player_id = v_player_id;
IF v_loop THEN
SELECT active_playlist_id INTO v_active_playlist_id
FROM players
WHERE id = v_player_id;
IF v_active_playlist_id IS NOT NULL THEN
SELECT loaded_count INTO v_loaded_count
FROM load_playlist(v_player_id, v_active_playlist_id, 0, TRUE);
IF v_loaded_count > 0 THEN
SELECT * INTO next_item
FROM queue
WHERE player_id = v_player_id
    AND type = 'normal'
    AND status = 'queued'
ORDER BY position ASC
LIMIT 1 FOR
UPDATE;
END IF;
END IF;
END IF;
END IF;
-- Mark next item as playing
IF next_item.id IS NOT NULL THEN -- Get duration from media_items
SELECT duration INTO v_duration
FROM media_items
WHERE id = next_item.media_item_id;
UPDATE queue
SET status = 'playing',
    started_at = now(),
    expected_end = now() + interval '1 second' * COALESCE(v_duration, 0),
    playback_state = 'playing',
    user_paused = FALSE,
    version = version + 1,
    last_heartbeat = now()
WHERE id = next_item.id;
UPDATE player_status
SET current_media_id = next_item.media_item_id,
    state = 'loading',
    progress = 0,
    last_updated = NOW()
WHERE player_id = v_player_id;
INSERT INTO event_log(event_type, queue_id, player_id, payload)
VALUES (
        'started',
        next_item.id,
        v_player_id,
        json_build_object()
    );
RETURN json_build_object(
    'status',
    'success',
    'completed_id',
    p_queue_id,
    'next_id',
    next_item.id,
    'next_media_item_id',
    next_item.media_item_id,
    'action',
    'advanced'
);
ELSE -- Queue exhausted
UPDATE player_status
SET current_media_id = NULL,
    state = 'idle',
    progress = 0,
    last_updated = NOW()
WHERE player_id = v_player_id;
INSERT INTO event_log(event_type, queue_id, player_id, payload)
VALUES (
        'queue_exhausted',
        p_queue_id,
        v_player_id,
        json_build_object()
    );
RETURN json_build_object(
    'status',
    'success',
    'completed_id',
    p_queue_id,
    'next_id',
    NULL,
    'action',
    'exhausted'
);
END IF;
END;
$$;
-- =========================
-- RPC: HEARTBEAT (updated to take queue_id and state)
-- =========================
CREATE OR REPLACE FUNCTION player_heartbeat(p_queue_id UUID, p_state TEXT) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$ BEGIN
UPDATE queue
SET last_heartbeat = now(),
    playback_state = p_state
WHERE id = p_queue_id
    AND status = 'playing';
INSERT INTO event_log(event_type, queue_id, payload)
VALUES (
        'heartbeat',
        p_queue_id,
        json_build_object('state', p_state)
    );
END;
$$;
-- =========================
-- RPC: HEALTH CHECK / SELF-HEAL
-- =========================
CREATE OR REPLACE FUNCTION ensure_playback_health() RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE current_item RECORD;
BEGIN
SELECT * INTO current_item
FROM queue
WHERE status = 'playing'
LIMIT 1;
IF current_item.id IS NULL THEN PERFORM start_next();
RETURN json_build_object('action', 'start_missing');
END IF;
-- STALLED (no heartbeat)
IF current_item.last_heartbeat IS NULL
OR current_item.last_heartbeat < now() - interval '30 seconds' THEN
UPDATE queue
SET playback_state = 'playing',
    version = version + 1
WHERE id = current_item.id;
INSERT INTO event_log(event_type, queue_id, player_id, payload)
VALUES (
        'force_resume_stalled',
        current_item.id,
        current_item.player_id,
        json_build_object()
    );
RETURN json_build_object('action', 'force_resume_stalled');
END IF;
-- UNEXPECTED PAUSE
IF current_item.playback_state = 'paused'
AND current_item.user_paused = FALSE THEN
UPDATE queue
SET playback_state = 'playing',
    version = version + 1
WHERE id = current_item.id;
INSERT INTO event_log(event_type, queue_id, player_id, payload)
VALUES (
        'force_resume_pause',
        current_item.id,
        current_item.player_id,
        json_build_object()
    );
RETURN json_build_object('action', 'force_resume_pause');
END IF;
-- TIMEOUT
IF current_item.expected_end IS NOT NULL
AND current_item.expected_end < now() THEN PERFORM complete_and_advance(current_item.id);
INSERT INTO event_log(event_type, queue_id, player_id, payload)
VALUES (
        'timeout_advance',
        current_item.id,
        current_item.player_id,
        json_build_object()
    );
RETURN json_build_object('action', 'timeout_advance');
END IF;
RETURN json_build_object('action', 'healthy');
END;
$$;
-- =========================
-- CRON JOB (every 5 seconds)
-- =========================
SELECT cron.schedule(
        'playback-health-check',
        '*/5 * * * * *',
        $$SELECT ensure_playback_health();
$$
);
-- ============================================================
-- END MIGRATION
-- ============================================================