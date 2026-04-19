-- =============================================================================
-- Migration: Sticky Priority Player with Explicit Claim Flow
--
-- Behaviour change:
--   BEFORE: priority_player_id was auto-cleared when the master went offline
--           (heartbeat failover), and any slave could silently reclaim master.
--
--   AFTER:  The priority player designation is STICKY — it never changes unless
--           the admin explicitly clicks "Reset Priority Player".
--           On reset, priority_selection_pending is set to TRUE and the old
--           priority_player_id is LEFT IN PLACE until a new player explicitly
--           claims master via claim_priority_player().
--           Slave players that connect while pending=TRUE are prompted to claim.
--
-- This means:
--   - A dedicated venue device remains master indefinitely, even when offline.
--   - Network blips do not cause unintended master reassignment.
--   - Master handoff is always an explicit, human-confirmed action.
-- =============================================================================

-- 1. Add priority_selection_pending column
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS priority_selection_pending BOOLEAN NOT NULL DEFAULT false;

-- 2. Update reset_priority_player_global:
--    Sets pending=TRUE but DOES NOT clear priority_player_id.
--    The old master remains master until a new player explicitly claims it.
CREATE OR REPLACE FUNCTION reset_priority_player_global()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.players
  SET priority_selection_pending = true
  WHERE true;
END;
$$;

-- 3. claim_priority_player: atomic master handoff.
--    Sets priority_player_id = new master on ALL rows, clears pending flag.
CREATE OR REPLACE FUNCTION claim_priority_player(p_player_id UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.players
  SET
    priority_player_id         = p_player_id,
    priority_selection_pending = false
  WHERE true;
END;
$$;

-- 4. Remove auto-failover from player_heartbeat.
--    The old version cleared priority_player_id when the master went offline.
--    We no longer do that — priority is sticky until explicitly reset.
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

  -- NOTE: Auto-failover (clearing priority_player_id on master offline) has been
  -- intentionally removed. Priority is now sticky and only changes when the admin
  -- explicitly triggers a reset followed by a player claiming master.

  -- Probabilistic expired-queue cleanup (~once per 25 min per active player)
  IF random() < 0.02 THEN
    DELETE FROM public.queue
    WHERE expires_at IS NOT NULL
      AND expires_at < NOW();
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.player_heartbeat(UUID)          TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reset_priority_player_global()  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_priority_player(UUID)     TO authenticated, service_role;
