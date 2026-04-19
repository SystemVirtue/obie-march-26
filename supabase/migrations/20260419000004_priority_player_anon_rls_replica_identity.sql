-- =============================================================================
-- Migration: Anon RLS policy on players + FULL replica identity
--
-- Problems fixed:
--   1. The players table had no anon SELECT policy. Player frontends use the
--      anon key and were blocked from reading priority_player_id /
--      priority_selection_pending. This caused heartbeat DB checks and
--      Realtime subscription filtering to silently fail.
--
--   2. players had REPLICA IDENTITY DEFAULT (only PK in Realtime payloads).
--      Realtime postgres_changes callbacks received empty `new` rows, so
--      priority_player_id and priority_selection_pending were never in the
--      payload, breaking instant detection of priority changes.
--
--   3. claim_priority_player was rewritten to explicitly clear
--      priority_selection_pending in a single UPDATE so the pending flag
--      can never stay true after a player claims master.
-- =============================================================================

-- 1. Allow anon (player app) to read all player rows
CREATE POLICY "anon_read_players"
  ON public.players FOR SELECT
  TO anon USING (true);

-- 2. Full replica identity so Realtime sends complete row data
ALTER TABLE public.players REPLICA IDENTITY FULL;

-- 3. Rewrite claim_priority_player to explicitly clear pending flag
CREATE OR REPLACE FUNCTION public.claim_priority_player(p_player_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE public.players
    SET priority_player_id         = p_player_id,
        priority_selection_pending = false,
        updated_at                 = NOW();
END;
$$;
