-- Migration: Add event_log table for debugging queue state transitions
-- This table logs all queue-related events for debugging and auditing.

CREATE TABLE IF NOT EXISTS event_log (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    event_type TEXT NOT NULL,
    queue_id UUID REFERENCES queue(id) ON DELETE SET NULL,
    player_id UUID REFERENCES players(id) ON DELETE SET NULL,
    payload JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add index for querying by queue_id
CREATE INDEX IF NOT EXISTS idx_event_log_queue_id ON event_log(queue_id);

-- Add index for querying by player_id
CREATE INDEX IF NOT EXISTS idx_event_log_player_id ON event_log(player_id);

-- Add index for querying by event_type
CREATE INDEX IF NOT EXISTS idx_event_log_event_type ON event_log(event_type);

-- Add index for querying by created_at (for time-based queries)
CREATE INDEX IF NOT EXISTS idx_event_log_created_at ON event_log(created_at DESC);

-- Add comment for documentation
COMMENT ON TABLE event_log IS 'Logs all queue-related events for debugging and auditing';
COMMENT ON COLUMN event_log.event_type IS 'Type of event (e.g., queue_completion_attempt, queue_duplicate_ignored, queue_state_transition)';
COMMENT ON COLUMN event_log.queue_id IS 'Associated queue item ID';
COMMENT ON COLUMN event_log.player_id IS 'Associated player ID';
COMMENT ON COLUMN event_log.payload IS 'Additional event data as JSONB';
