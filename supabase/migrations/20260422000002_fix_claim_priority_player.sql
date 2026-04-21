-- Fix claim_priority_player to use proper WHERE clause
-- Same issue as reset_priority_player_global - WHERE true is rejected

CREATE OR REPLACE FUNCTION public.claim_priority_player(p_player_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.players
    SET priority_player_id         = p_player_id,
        priority_selection_pending = false,
        updated_at                 = NOW()
  WHERE id IS NOT NULL;
END;
$$;
