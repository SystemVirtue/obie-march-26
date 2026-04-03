-- =============================================================================
-- Fix stale queue cleanup in player_heartbeat
--
-- Migration 20260401000001_reduce_disk_io changed queue_next to DELETE played
-- items immediately instead of marking them with played_at = NOW().  As a
-- result the periodic cleanup added by 20260328000005_heartbeat_queue_cleanup
-- (DELETE FROM queue WHERE played_at IS NOT NULL) is now a no-op — no rows
-- with a non-null played_at will ever exist.
--
-- This migration rewrites player_heartbeat so the probabilistic cleanup
-- instead targets queue rows whose expires_at has passed, which are the only
-- legitimate stale rows that can accumulate (kiosk requests that were never
-- served, for example).
-- =============================================================================

CREATE OR REPLACE FUNCTION player_heartbeat(
  p_player_id UUID
)
RETURNS void AS $$
BEGIN
  UPDATE players
  SET
    status        = 'online',
    last_heartbeat = NOW(),
    updated_at    = NOW()
  WHERE id = p_player_id;

  -- Mark other players offline if no heartbeat in 45 seconds
  UPDATE players
  SET status = 'offline'
  WHERE id != p_player_id
    AND status  = 'online'
    AND last_heartbeat < NOW() - INTERVAL '45 seconds';

  -- Probabilistic cleanup (~once per 25 min per active player).
  -- Removes queue rows whose explicit expiry has passed.
  -- (played_at-based cleanup removed: items are now deleted by queue_next
  --  immediately when played, so played_at is never set.)
  IF random() < 0.02 THEN
    DELETE FROM public.queue
    WHERE expires_at IS NOT NULL
      AND expires_at < NOW();
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;
