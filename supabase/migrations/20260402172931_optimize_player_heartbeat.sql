-- =============================================================================
-- Optimize player_heartbeat: switch cleanup from played_at to expires_at
-- Applied directly to DB on 2026-04-02; stub added to keep local migrations in sync.
--
-- Migration 20260402172912_add_performance_indexes changed the queue model so that
-- played items are deleted by queue_next rather than marked with played_at.
-- The old probabilistic cleanup (DELETE WHERE played_at IS NOT NULL) became a no-op.
-- This migration rewrites it to instead purge rows whose expires_at has passed
-- (kiosk requests that were never served, etc).
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
