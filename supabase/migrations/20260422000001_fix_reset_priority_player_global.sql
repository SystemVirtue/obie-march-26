-- Fix reset_priority_player_global to use proper WHERE clause
-- Supabase rejects "WHERE true" in some configurations
-- Use "WHERE id IS NOT NULL" to update all rows safely

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
