-- Migration: Add RPC functions for atomic global priority player updates
-- This fixes the issue where .update() without filters fails in Edge Functions

CREATE OR REPLACE FUNCTION set_priority_player_global(p_priority_player_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE public.players
  SET priority_player_id = p_priority_player_id
  WHERE true;  -- Updates all rows
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION reset_priority_player_global()
RETURNS void AS $$
BEGIN
  UPDATE public.players
  SET priority_player_id = NULL
  WHERE true;  -- Updates all rows
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
