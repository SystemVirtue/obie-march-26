-- Add periodic queue cleanup to player_heartbeat.
-- Heartbeat fires every 30s per player. Using random() < 0.02 means cleanup
-- runs roughly once per 25 minutes per active player (~1/50 chance per call).
-- This keeps the queue table lean without requiring pg_cron.

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

  -- Mark offline if no heartbeat in 45 seconds (supports 30 s client interval)
  UPDATE players
  SET status = 'offline'
  WHERE id != p_player_id
    AND status = 'online'
    AND last_heartbeat < NOW() - INTERVAL '45 seconds';

  -- Periodically clean up old played queue items (>24h old)
  IF random() < 0.02 THEN
    DELETE FROM public.queue
    WHERE played_at IS NOT NULL
      AND played_at < NOW() - INTERVAL '24 hours';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;
