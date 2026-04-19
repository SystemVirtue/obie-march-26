-- =============================================================================
-- Fix: reset_priority_player_global overwritten by mis-ordered migration
--
-- Root cause: 20260419_priority_player_global_update.sql sorts AFTER
-- 20260419000002_priority_player_sticky.sql because ASCII '_' (95) > '0' (48).
-- That older file ran last and replaced reset_priority_player_global() with a
-- version that does SET priority_player_id = NULL — clearing the master without
-- ever setting priority_selection_pending = true. Result: admin reset triggered
-- all players to have priority_player_id = null, no pending flag was set, and
-- the claim modal never fired on any player window.
--
-- This migration has timestamp 20260420000001 so it sorts after all 20260419*
-- files and becomes the final authoritative definition.
--
-- Correct sticky behaviour:
--   SET priority_selection_pending = true (signals players to show claim modal)
--   Do NOT touch priority_player_id (old master stays designated until a player
--   explicitly claims via claim_priority_player())
-- =============================================================================

CREATE OR REPLACE FUNCTION public.reset_priority_player_global()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.players
  SET priority_selection_pending = true;
  -- NOTE: priority_player_id is intentionally NOT cleared here.
  -- The old master remains designated until a new player confirms the
  -- claim modal and calls claim_priority_player(), which atomically sets
  -- priority_player_id = new_player AND clears priority_selection_pending.
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_priority_player_global() TO authenticated, service_role;
