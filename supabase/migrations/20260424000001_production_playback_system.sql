-- ============================================================
-- OBI Jukebox: Deterministic Playback + Self-Healing Queue
-- Full Supabase Migration
-- ============================================================
-- Increase statement timeout for large table alterations
SET statement_timeout = '10min';
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
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS expected_end TIMESTAMPTZ,
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
CREATE INDEX IF NOT EXISTS idx_queue_created ON queue(requested_at);
-- =========================
-- EVENT LOG TABLE
-- =========================
CREATE TABLE IF NOT EXISTS event_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT,
    queue_id UUID,
    player_id UUID,
    payload JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
-- Index for event log queries
CREATE INDEX IF NOT EXISTS idx_event_log_queue_id ON event_log(queue_id);
CREATE INDEX IF NOT EXISTS idx_event_log_created_at ON event_log(created_at);
-- =========================
-- RPC: START NEXT
-- =========================
CREATE OR REPLACE FUNCTION start_next(p_player_id UUID) RETURNS JSON LANGUAGE plpgsql AS $$
DECLARE next_item RECORD;
media_duration INT;
BEGIN -- Lock next available item for this player
SELECT q.* INTO next_item
FROM queue q
WHERE q.player_id = p_player_id
    AND q.status = 'queued'
ORDER BY CASE
        WHEN q.type = 'priority' THEN 0
        ELSE 1
    END,
    q.position ASC
LIMIT 1 FOR
UPDATE SKIP LOCKED;
IF next_item.id IS NULL THEN -- No items in queue
INSERT INTO event_log(event_type, player_id, payload)
VALUES (
        'start_next_empty',
        p_player_id,
        json_build_object()
    );
RETURN json_build_object('status', 'empty');
END IF;
-- Get duration from media_items
SELECT duration INTO media_duration
FROM media_items
WHERE id = next_item.media_item_id;
UPDATE queue
SET status = 'playing',
    started_at = NOW(),
    expected_end = NOW() + (COALESCE(media_duration, 0) || ' seconds')::INTERVAL,
    playback_state = 'playing',
    user_paused = FALSE,
    version = version + 1,
    last_heartbeat = NOW()
WHERE id = next_item.id;
INSERT INTO event_log(event_type, queue_id, player_id, payload)
VALUES (
        'start',
        next_item.id,
        p_player_id,
        json_build_object(
            'media_item_id',
            next_item.media_item_id,
            'type',
            next_item.type
        )
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
-- RPC: COMPLETE + ADVANCE
-- =========================
CREATE OR REPLACE FUNCTION complete_and_advance(p_queue_id UUID) RETURNS JSON LANGUAGE plpgsql AS $$
DECLARE current_item RECORD;
player_id_val UUID;
BEGIN
SELECT * INTO current_item
FROM queue
WHERE id = p_queue_id FOR
UPDATE;
IF current_item.id IS NULL THEN
INSERT INTO event_log(event_type, queue_id, payload)
VALUES (
        'complete_not_found',
        p_queue_id,
        json_build_object()
    );
RETURN json_build_object(
    'status',
    'error',
    'reason',
    'queue_item_not_found'
);
END IF;
-- Idempotency guard: only proceed if still playing
IF current_item.status != 'playing' THEN
INSERT INTO event_log(event_type, queue_id, player_id, payload)
VALUES (
        'ignored_duplicate',
        p_queue_id,
        current_item.player_id,
        json_build_object(
            'current_status',
            current_item.status
        )
    );
RETURN json_build_object(
    'status',
    'ignored',
    'reason',
    current_item.status
);
END IF;
player_id_val := current_item.player_id;
UPDATE queue
SET status = 'completed',
    completed_at = NOW(),
    playback_state = 'ended',
    version = version + 1
WHERE id = p_queue_id;
INSERT INTO event_log(event_type, queue_id, player_id, payload)
VALUES (
        'completed',
        p_queue_id,
        player_id_val,
        json_build_object()
    );
-- Start next item
PERFORM start_next(player_id_val);
RETURN json_build_object('status', 'advanced', 'player_id', player_id_val);
END;
$$;
-- =========================
-- RPC: HEARTBEAT
-- =========================
CREATE OR REPLACE FUNCTION player_heartbeat(p_queue_id UUID, p_state TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE current_item RECORD;
BEGIN
SELECT * INTO current_item
FROM queue
WHERE id = p_queue_id FOR
UPDATE;
IF current_item.id IS NULL THEN RETURN;
END IF;
UPDATE queue
SET last_heartbeat = NOW(),
    playback_state = p_state
WHERE id = p_queue_id
    AND status = 'playing';
INSERT INTO event_log(event_type, queue_id, player_id, payload)
VALUES (
        'heartbeat',
        p_queue_id,
        current_item.player_id,
        json_build_object('state', p_state)
    );
END;
$$;
-- =========================
-- RPC: SET USER PAUSED
-- =========================
CREATE OR REPLACE FUNCTION set_user_paused(p_queue_id UUID, p_paused BOOLEAN) RETURNS JSON LANGUAGE plpgsql AS $$
DECLARE current_item RECORD;
BEGIN
SELECT * INTO current_item
FROM queue
WHERE id = p_queue_id FOR
UPDATE;
IF current_item.id IS NULL THEN RETURN json_build_object('status', 'error', 'reason', 'not_found');
END IF;
UPDATE queue
SET user_paused = p_paused,
    playback_state = CASE
        WHEN p_paused THEN 'paused'
        ELSE 'playing'
    END,
    version = version + 1
WHERE id = p_queue_id
    AND status = 'playing';
INSERT INTO event_log(event_type, queue_id, player_id, payload)
VALUES (
        'user_pause_change',
        p_queue_id,
        current_item.player_id,
        json_build_object('paused', p_paused)
    );
RETURN json_build_object('status', 'success');
END;
$$;
-- =========================
-- RPC: HEALTH CHECK / SELF-HEAL
-- =========================
CREATE OR REPLACE FUNCTION ensure_playback_health() RETURNS JSON LANGUAGE plpgsql AS $$
DECLARE current_item RECORD;
action_taken TEXT;
BEGIN -- Find all currently playing items across all players
FOR current_item IN
SELECT q.*,
    p.id as player_id
FROM queue q
    JOIN players p ON q.player_id = p.id
WHERE q.status = 'playing'
ORDER BY q.started_at ASC LOOP action_taken := 'healthy';
-- STALLED (no heartbeat for 30 seconds)
IF current_item.last_heartbeat IS NULL
OR current_item.last_heartbeat < NOW() - INTERVAL '30 seconds' THEN
UPDATE queue
SET playback_state = 'playing',
    user_paused = FALSE,
    version = version + 1
WHERE id = current_item.id;
INSERT INTO event_log(event_type, queue_id, player_id, payload)
VALUES (
        'force_resume_stalled',
        current_item.id,
        current_item.player_id,
        json_build_object(
            'last_heartbeat',
            current_item.last_heartbeat
        )
    );
action_taken := 'force_resume_stalled';
END IF;
-- UNEXPECTED PAUSE (not user-initiated)
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
action_taken := 'force_resume_pause';
END IF;
-- TIMEOUT (exceeded expected end time with 10 second buffer)
IF current_item.expected_end IS NOT NULL
AND current_item.expected_end < NOW() - INTERVAL '10 seconds' THEN PERFORM complete_and_advance(current_item.id);
INSERT INTO event_log(event_type, queue_id, player_id, payload)
VALUES (
        'timeout_advance',
        current_item.id,
        current_item.player_id,
        json_build_object(
            'expected_end',
            current_item.expected_end
        )
    );
action_taken := 'timeout_advance';
END IF;
END LOOP;
-- Check for players with no playing item but items in queue
FOR current_item IN
SELECT DISTINCT p.id as player_id
FROM players p
WHERE EXISTS (
        SELECT 1
        FROM queue q
        WHERE q.player_id = p.id
            AND q.status = 'queued'
    )
    AND NOT EXISTS (
        SELECT 1
        FROM queue q
        WHERE q.player_id = p.id
            AND q.status = 'playing'
    ) LOOP PERFORM start_next(current_item.player_id);
INSERT INTO event_log(event_type, player_id, payload)
VALUES (
        'start_missing_playing',
        current_item.player_id,
        json_build_object()
    );
END LOOP;
RETURN json_build_object('status', 'success', 'action', action_taken);
END;
$$;
-- =========================
-- RPC: SKIP CURRENT ITEM
-- =========================
CREATE OR REPLACE FUNCTION skip_current(p_player_id UUID) RETURNS JSON LANGUAGE plpgsql AS $$
DECLARE current_item RECORD;
BEGIN
SELECT * INTO current_item
FROM queue
WHERE player_id = p_player_id
    AND status = 'playing' FOR
UPDATE;
IF current_item.id IS NULL THEN RETURN json_build_object('status', 'error', 'reason', 'no_playing_item');
END IF;
UPDATE queue
SET status = 'skipped',
    completed_at = NOW(),
    playback_state = 'ended',
    version = version + 1
WHERE id = current_item.id;
INSERT INTO event_log(event_type, queue_id, player_id, payload)
VALUES (
        'skipped',
        current_item.id,
        p_player_id,
        json_build_object()
    );
PERFORM start_next(p_player_id);
RETURN json_build_object('status', 'skipped', 'queue_id', current_item.id);
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