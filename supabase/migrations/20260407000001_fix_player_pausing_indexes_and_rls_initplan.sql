-- Fix player pausing: add missing FK indexes + fix RLS initplan performance
--
-- Part 1: Missing FK indexes cause sequential scans during song transitions.
-- The player-control edge function spikes to 1.5-1.8s because:
--   1. player_status JOINs media_items via current_media_id with no index
--   2. queue JOINs media_items via media_item_id with no index
-- These slow queries delay Realtime events reaching the player client,
-- causing loading/pause timeouts to fire prematurely and auto-skip songs.
--
-- Note: idx_players_priority_player_id already exists (20260401000001).
--
-- Part 2: RLS auth.uid() initplan fix on players table.
-- Supabase advisor: auth.uid() is re-evaluated for every row when used
-- directly in RLS policies. Wrapping in (SELECT auth.uid()) causes it to
-- be evaluated once per query, significantly reducing policy overhead.
-- The players table is most critical: checked on every song transition.
--
-- Note: media_items and r2_files policies already use (SELECT auth.role())
-- pattern from 20260328000003_consolidate_remaining_rls_policies.sql.

-- ============================================================================
-- Part 1: Missing FK indexes
-- ============================================================================

-- Index for player_status.current_media_id
-- Hit on every player_status fetch with current_media:media_items(*) join
CREATE INDEX IF NOT EXISTS idx_player_status_current_media_id
  ON public.player_status (current_media_id);

-- Index for queue.media_item_id
-- Hit on every queue fetch with media_item:media_items(*) join
CREATE INDEX IF NOT EXISTS idx_queue_media_item_id
  ON public.queue (media_item_id);

-- ============================================================================
-- Part 2: Fix RLS initplan on players table
-- ============================================================================

-- Fix "Member access to own players" — use (SELECT auth.uid()) to avoid
-- per-row re-evaluation of auth.uid()
DROP POLICY IF EXISTS "Member access to own players" ON public.players;
CREATE POLICY "Member access to own players" ON public.players
  FOR ALL
  USING (
    (owner_id = (SELECT auth.uid()))
    OR (EXISTS (
      SELECT 1 FROM player_memberships pm
      WHERE pm.player_id = players.id
        AND pm.user_id = (SELECT auth.uid())
    ))
  )
  WITH CHECK (
    (owner_id = (SELECT auth.uid()))
    OR (EXISTS (
      SELECT 1 FROM player_memberships pm
      WHERE pm.player_id = players.id
        AND pm.user_id = (SELECT auth.uid())
        AND pm.role = ANY (ARRAY['owner'::text, 'admin'::text, 'operator'::text])
    ))
  );
