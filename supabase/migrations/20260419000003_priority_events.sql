-- =============================================================================
-- Migration: Priority player event log + Realtime publication fix
--
-- Problems fixed:
--   1. The players table was removed from the Realtime publication in migration
--      20260328000001, so player frontends had no way to detect priority changes
--      in real time. The modal was only shown on the next heartbeat (≤ 30 s delay).
--      Re-adding it here allows instant detection via postgres_changes subscription.
--
--   2. No audit trail existed for priority player assignments/resets.
--      This migration adds priority_player_events to log every change.
-- =============================================================================

-- 1. Re-add players to the Realtime publication so frontends can subscribe
--    to priority_player_id and priority_selection_pending changes instantly.
--    Priority changes are rare (admin-triggered only), so WAL overhead is minimal.
ALTER PUBLICATION supabase_realtime ADD TABLE public.players;

-- 2. Priority event log table
CREATE TABLE IF NOT EXISTS public.priority_player_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   TEXT        NOT NULL
                           CHECK (event_type IN ('reset_requested', 'claimed', 'confirmed')),
  player_id    UUID        REFERENCES public.players(id) ON DELETE SET NULL,
  previous_priority_id UUID REFERENCES public.players(id) ON DELETE SET NULL,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. RLS — readable by authenticated users (admin), writable only by service_role
ALTER TABLE public.priority_player_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read_priority_events"
  ON public.priority_player_events FOR SELECT
  TO authenticated USING (true);

-- service_role bypasses RLS, so no INSERT policy needed for the edge function.
-- Add anon read-through for the player app (needs to read its own events for display):
CREATE POLICY "anon_read_priority_events"
  ON public.priority_player_events FOR SELECT
  TO anon USING (true);
