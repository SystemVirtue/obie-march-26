-- Fix reset_priority_player_global - ensure it does NOT clear priority_player_id
-- The old migration (20260419_priority_player_global_update.sql) was applied and
-- cleared priority_player_id, causing any player to auto-claim on refresh.
-- This migration restores the correct sticky priority behavior.

CREATE OR REPLACE FUNCTION reset_priority_player_global()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.players
  SET priority_selection_pending = true
  WHERE id IS NOT NULL;
END;
$$;
