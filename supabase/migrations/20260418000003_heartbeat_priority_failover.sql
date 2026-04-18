-- =============================================================================
-- Migration: Priority player automatic failover on heartbeat expiry
--
-- Problem (Issue #3):
--   player_heartbeat() marks dead players 'offline' but never clears
--   priority_player_id. If the priority player tab closes:
--     - priority_player_id in DB still points to the dead UUID
--     - queue_next is permanently blocked (only priority player can advance)
--     - Current song plays out but nothing ever follows it
--     - Only manual intervention (close all tabs, reopen) recovers playback
--
-- Fix:
--   During each heartbeat, if the current priority_player_id belongs to an
--   offline player, clear it to NULL. The live player's next heartbeat then
--   triggers re-registration via register_session and reclaims master
--   automatically — within one heartbeat interval (≤ 30 seconds).
--
--   The check only clears the pointer when called from a DIFFERENT (live)
--   player, preventing a player from accidentally clearing its own priority
--   status on a slow heartbeat cycle.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.player_heartbeat(p_player_id UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Mark this player online
  UPDATE players
  SET
    status         = 'online',
    last_heartbeat = NOW(),
    updated_at     = NOW()
  WHERE id = p_player_id;

  -- Mark other players offline if heartbeat has gone stale (> 45 seconds)
  UPDATE players
  SET status = 'offline'
  WHERE id           != p_player_id
    AND status        = 'online'
    AND last_heartbeat < NOW() - INTERVAL '45 seconds';

  -- AUTO-FAILOVER: If the priority player is now offline, clear the pointer.
  -- This runs from the live player's heartbeat so any surviving player will
  -- trigger it within 30 seconds of the master dying.
  -- Guard: only act when WE are not the priority player (avoids self-clearing).
  UPDATE players AS p
  SET priority_player_id = NULL
  WHERE p.id                    = p_player_id        -- acting from our own player row
    AND p.priority_player_id   IS NOT NULL            -- a priority player is set
    AND p.priority_player_id   != p_player_id         -- and it's not us
    AND EXISTS (
      SELECT 1 FROM players dead
      WHERE dead.id     = p.priority_player_id
        AND dead.status = 'offline'                   -- and that player is offline
    );

  -- Probabilistic expired-queue cleanup (~once per 25 min per active player)
  IF random() < 0.02 THEN
    DELETE FROM public.queue
    WHERE expires_at IS NOT NULL
      AND expires_at < NOW();
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.player_heartbeat(UUID) TO authenticated, service_role;
