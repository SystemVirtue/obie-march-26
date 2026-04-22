-- Migration: Add queue status columns for server-controlled progression
-- This migration adds status tracking to the queue table to enable
-- atomic, server-controlled queue progression without master/slave architecture.

-- Add status column with check constraint
ALTER TABLE queue
ADD COLUMN IF NOT EXISTS status TEXT
CHECK (status IN ('queued', 'playing', 'completed', 'skipped'))
DEFAULT 'queued';

-- Add version column for optimistic concurrency
ALTER TABLE queue
ADD COLUMN IF NOT EXISTS version INT DEFAULT 0;

-- Add started_at timestamp
ALTER TABLE queue
ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

-- Add completed_at timestamp
ALTER TABLE queue
ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Add comment for documentation
COMMENT ON COLUMN queue.status IS 'Queue item status: queued=waiting to play, playing=currently playing, completed=finished, skipped=manually skipped';
COMMENT ON COLUMN queue.version IS 'Optimistic concurrency version - incremented on each state transition';
COMMENT ON COLUMN queue.started_at IS 'Timestamp when item started playing';
COMMENT ON COLUMN queue.completed_at IS 'Timestamp when item completed or was skipped';

-- Initialize existing items: items with played_at set are completed, others are queued
UPDATE queue
SET status = CASE
  WHEN played_at IS NOT NULL THEN 'completed'
  ELSE 'queued'
END,
completed_at = played_at
WHERE status IS NULL;
