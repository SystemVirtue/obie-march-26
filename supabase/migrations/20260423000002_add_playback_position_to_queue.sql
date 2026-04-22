-- Add playback_position column to queue table for resume functionality
-- This allows players to resume from where they left off after disconnect
ALTER TABLE public.queue
ADD COLUMN IF NOT EXISTS playback_position FLOAT DEFAULT 0 CHECK (playback_position >= 0 AND playback_position <= 1);

-- Add index for faster queries on playing items with position
CREATE INDEX IF NOT EXISTS idx_queue_playing_position 
ON public.queue (player_id, status) 
WHERE status = 'playing';

COMMENT ON COLUMN public.queue.playback_position IS 'Playback position (0-1) for resume capability. Updated periodically by active player.';
