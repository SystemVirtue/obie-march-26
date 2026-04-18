-- =============================================================================
-- Migration: Fix reset_priority — allow claim when no master is set
--
-- Problem:
--   After "Reset Priority Player" clears priority_player_id to NULL, any slave
--   player attempting to claim master via claim_priority_player() was blocked by
--   the v_other_playing guard: if the old master's player_status.state was still
--   'playing', the guard returned FALSE for every new claimant.  Nobody could
--   become master until the old master's song finished.
--
-- Fix:
--   The v_other_playing guard exists to prevent a slave stealing master from a
--   live, active master player.  But when priority_player_id IS NULL, there IS
--   no master — the reset was intentional.  We therefore skip the guard entirely
--   when priority_player_id is NULL so the next player to refresh always wins.
--
--   The "different player already online" guard still applies as before when
--   priority_player_id IS NOT NULL (normal slave → master transitions).
--
-- Additionally:
--   The reset_priority action in the edge function was not clearing
--   priority_session_id.  That is fixed in the edge function directly, but this
--   migration also adds the same clarity to the DB-level function for safety.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.claim_priority_player(
  p_player_id    UUID,
  p_session_id   TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_priority_id      UUID;
  v_priority_session TEXT;
  v_other_playing    BOOLEAN;
BEGIN
  -- Serialise all priority elections for this player.  Two tabs opening
  -- simultaneously will queue here; exactly one will claim master.
  PERFORM pg_advisory_xact_lock(hashtext(p_player_id::text));

  SELECT priority_player_id, priority_session_id
  INTO   v_priority_id, v_priority_session
  FROM   players
  WHERE  id = p_player_id
  FOR UPDATE;

  -- Idempotent re-claim: this session already holds master.
  IF v_priority_id = p_player_id AND v_priority_session = p_session_id THEN
    RETURN TRUE;
  END IF;

  -- A different session of THIS same player already holds master → slave.
  -- Prevents two browser tabs for the same jukebox both thinking they are master.
  IF v_priority_id = p_player_id
     AND v_priority_session IS NOT NULL
     AND v_priority_session != p_session_id THEN
    RETURN FALSE;
  END IF;

  -- A DIFFERENT player holds priority and is still online → slave.
  -- (Only applies when a live master exists — not the reset-priority case.)
  IF v_priority_id IS NOT NULL AND v_priority_id != p_player_id THEN
    IF EXISTS (
      SELECT 1 FROM players
      WHERE  id = v_priority_id AND status = 'online'
    ) THEN
      RETURN FALSE;
    END IF;
    -- Falls through: that other player is offline — safe to claim.
  END IF;

  -- v_other_playing guard: only apply when a master IS currently set.
  --
  -- When priority_player_id IS NULL the admin has deliberately reset master
  -- (or the master died and heartbeat cleared it).  In this case we WANT the
  -- next player to claim master immediately, even if the old player is still
  -- producing audio — it is no longer the authoritative master and will be
  -- demoted by its own heartbeat check (see usePlayerHeartbeat.ts).
  --
  -- When priority_player_id IS NOT NULL (normal slave-to-master transition) we
  -- still block if another player is actively playing, to avoid a race where a
  -- brief heartbeat gap causes a spurious priority hand-off mid-song.
  IF v_priority_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM player_status
      WHERE  state = 'playing' AND player_id != p_player_id
    ) INTO v_other_playing;

    IF v_other_playing THEN
      RETURN FALSE;
    END IF;
  END IF;

  -- Grant master to this player + session.
  UPDATE players
  SET    priority_player_id  = p_player_id,
         priority_session_id = p_session_id
  WHERE  id = p_player_id;

  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_priority_player(UUID, TEXT) TO service_role;
